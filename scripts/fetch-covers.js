'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const VERCAPAS_SLUGS = [
  'publico', 'diario-de-noticias', 'jornal-de-noticias', 'correio-da-manha', 'expresso',
  'jornal-de-negocios', 'jornal-economico',
  'a-bola', 'record', 'o-jogo',
  'visao', 'sabado', 'o-diabo',
  'acoriano-oriental', 'correio-do-minho',
];

// sapo.pt is the primary source: it carries every title, isn't behind Cloudflare
// (so datacenter IPs reach it directly, no reader proxy needed), and serves clean
// JPEGs. Map each output slug to its sapo section + "<slug>-<id>" route segment
// (the id is a stable per-publication number). El País is also here so it gets a
// primary before the kiosko fallback.
const SAPO_PUBS = {
  'publico':            { section: 'nacional',      path: 'publico-4090' },
  'diario-de-noticias': { section: 'nacional',      path: 'diario-de-noticias-4074' },
  'jornal-de-noticias': { section: 'nacional',      path: 'jornal-de-noticias-4085' },
  'correio-da-manha':   { section: 'nacional',      path: 'correio-da-manha-4063' },
  'expresso':           { section: 'nacional',      path: 'expresso-4098' },
  'jornal-de-negocios': { section: 'economia',      path: 'jornal-de-negocios-4108' },
  'jornal-economico':   { section: 'economia',      path: 'jornal-economico-10140' },
  'a-bola':             { section: 'desporto',      path: 'a-bola-4137' },
  'record':             { section: 'desporto',      path: 'record-4139' },
  'o-jogo':             { section: 'desporto',      path: 'o-jogo-4138' },
  'visao':              { section: 'nacional',      path: 'visao-4104' },
  'sabado':             { section: 'nacional',      path: 'sabado-4103' },
  'o-diabo':            { section: 'nacional',      path: 'o-diabo-4101' },
  'acoriano-oriental':  { section: 'local',         path: 'acoriano-oriental-3925' },
  'correio-do-minho':   { section: 'local',         path: 'correio-do-minho-3940' },
  'elpais':             { section: 'internacional', path: 'el-pais-4404' },
};

const COVERS_DIR = path.join(__dirname, '..', 'covers');

// A full, realistic browser User-Agent + companion headers. Cloudflare's bot
// heuristics block datacenter IPs (e.g. GitHub Actions runners) aggressively
// when the request also carries a weak UA like "Mozilla/5.0 (compatible)".
// Presenting as a real Chrome browser is what lets the CI run pass.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Optional jina.ai reader API key. Without one the reader works but is rate
// limited (~20 req/min per IP, shared across runners); a free key raises that
// substantially. Set it as the JINA_API_KEY secret in the workflow if the
// unauthenticated limit ever proves too tight.
const JINA_API_KEY = process.env.JINA_API_KEY || '';

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

function browserHeaders(extra) {
  return {
    'User-Agent': BROWSER_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
    ...extra,
  };
}

function httpsGet(options, timeoutMs = 15000, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    let timer;
    const req = https.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && maxRedirects > 0) {
        res.resume();
        clearTimeout(timer);
        const loc = res.headers.location;
        if (!loc) { reject(new Error('REDIRECT_NO_LOCATION')); return; }
        try {
          const u = new URL(loc, `https://${options.hostname}${options.path}`);
          httpsGet({
            hostname: u.hostname,
            path: u.pathname + (u.search || ''),
            method: 'GET',
            headers: options.headers,
          }, timeoutMs, maxRedirects - 1).then(resolve).catch(reject);
        } catch (e) {
          reject(e);
        }
        return;
      }
      clearTimeout(timer);
      resolve(res);
    });
    timer = setTimeout(() => {
      req.destroy(new Error('TIMEOUT'));
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(req.destroyed ? new Error('TIMEOUT') : err);
    });
    req.end();
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => resolve(data));
    res.on('error', reject);
  });
}

function saveBody(res, filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
}

// ── sapo.pt (primary source) ─────────────────────────────────

async function fetchText(hostname, path) {
  const res = await httpsGet({
    hostname,
    path,
    method: 'GET',
    headers: browserHeaders(),
  });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP_${res.statusCode}`);
  }
  return readBody(res);
}

// Section listings are shared across all papers in that section, so fetch each
// at most once. Cache the in-flight promise so concurrent workers don't refetch.
const sapoSectionCache = new Map();
function getSapoSection(section) {
  if (!sapoSectionCache.has(section)) {
    sapoSectionCache.set(section, fetchText('sapo.pt', `/noticias/jornais/${section}`));
  }
  return sapoSectionCache.get(section);
}

async function fetchSapo(outSlug) {
  const pub = SAPO_PUBS[outSlug];
  if (!pub) throw new Error('SAPO_NO_MAP');

  // The dateless route 404s and weeklies only exist on publish days, so read the
  // current edition's route (with its date) straight from the section listing.
  const listing = await getSapoSection(pub.section);
  const routeRe = new RegExp(`noticias/jornais/${pub.section}/${pub.path}/\\d+`);
  const routeMatch = listing.match(routeRe);
  if (!routeMatch) throw new Error('SAPO_NO_ROUTE');

  // The detail page holds the cover as a thumbs.web.sapo.io image URL.
  const detail = await fetchText('sapo.pt', `/${routeMatch[0]}`);
  const picMatch = detail.match(/thumbs\.web\.sapo\.io\/\?pic=[^"'\s]+/);
  if (!picMatch) throw new Error('SAPO_NO_IMAGE');

  // Normalise: decode &amp; and drop webp so we save a plain JPEG.
  const thumbUrl = 'https://' + picMatch[0].replace(/&amp;/g, '&').replace(/&webp=1/, '');
  const u = new URL(thumbUrl);
  const imgRes = await httpsGet({
    hostname: u.hostname,
    path: u.pathname + u.search,
    method: 'GET',
    headers: browserHeaders({
      'Referer': 'https://sapo.pt/',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    }),
  });
  if (imgRes.statusCode !== 200) {
    imgRes.resume();
    throw new Error(`SAPO_IMG_HTTP_${imgRes.statusCode}`);
  }
  await saveBody(imgRes, path.join(COVERS_DIR, `${outSlug}.jpg`));
}

async function getVercapasImageUrl(slug) {
  // www.vercapas.com is behind Cloudflare, which network-blocks datacenter IPs
  // (e.g. GitHub Actions runners) with a 403 regardless of User-Agent. We route
  // the HTML scrape through the r.jina.ai reader, whose egress is not blocked,
  // and ask it for raw HTML (X-Return-Format: html) so the hashed cover URL
  // survives — the default Markdown conversion drops it.
  const target = `https://www.vercapas.com/capa/${slug}.html`;
  const pattern = new RegExp(`covers/${slug}/\\d+/${slug}-[\\d-]+[a-f0-9]+\\.jpg`);

  // Retry on rate limiting (429), transient block (403/5xx), AND on a 200 that
  // lacks the cover URL — jina caches responses, and it occasionally caches a
  // Cloudflare interstitial ("Just a moment", 200) or a partial render, which
  // shows up as NO_MATCH. X-No-Cache on retries forces a fresh origin fetch.
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Send NO User-Agent: r.jina.ai forwards request headers to the origin, and
    // a browser UA over jina's own TLS/IP fingerprint trips Cloudflare's
    // challenge (403). With no UA, jina uses its own consistent fingerprint.
    const headers = { 'X-Return-Format': 'html' };
    if (attempt > 1) headers['X-No-Cache'] = 'true';
    if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;

    let res;
    try {
      res = await httpsGet({
        hostname: 'r.jina.ai',
        path: `/${target}`,
        method: 'GET',
        headers,
      });
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw err.message === 'TIMEOUT' ? err : new Error('UPSTREAM_ERROR');
      }
      await sleep(attempt * 2000);
      continue;
    }

    if (res.statusCode === 200) {
      let html = '';
      try {
        html = await readBody(res);
      } catch { /* fall through to retry */ }
      const match = html.match(pattern);
      if (match) return `https://imgs.vercapas.com/${match[0]}`;
      // 200 but no cover URL — retry with a fresh render.
      if (attempt >= maxAttempts) throw new Error('NO_MATCH');
      await sleep(attempt * 2000);
      continue;
    }

    res.resume();
    const retriable = res.statusCode === 429 || res.statusCode === 403 || res.statusCode >= 500;
    if (retriable && attempt < maxAttempts) {
      await sleep(attempt * 2000);
      continue;
    }
    throw new Error(`VERCAPAS_HTTP_${res.statusCode}`);
  }
  throw new Error('NO_MATCH');
}

// Fetch the cover image. imgs.vercapas.com has served datacenter IPs fine for a
// long time (only the www HTML host is blocked), so we try it directly first;
// if it ever starts returning non-200 we fall back to the images.weserv.nl
// image proxy, which fetches server-side from an unblocked network.
async function fetchVercapasImage(imageUrl) {
  const u = new URL(imageUrl);
  const direct = await httpsGet({
    hostname: u.hostname,
    path: u.pathname + (u.search || ''),
    method: 'GET',
    headers: browserHeaders({
      'Referer': 'https://www.vercapas.com/',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'same-site',
    }),
  });
  if (direct.statusCode === 200) return direct;
  direct.resume();

  // Fallback: proxy through weserv (host + path, no scheme, URL-encoded).
  const proxied = `https://images.weserv.nl/?url=${encodeURIComponent(u.hostname + u.pathname)}`;
  const p = new URL(proxied);
  const viaProxy = await httpsGet({
    hostname: p.hostname,
    path: p.pathname + p.search,
    method: 'GET',
    headers: browserHeaders({
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    }),
  });
  if (viaProxy.statusCode !== 200) {
    viaProxy.resume();
    throw new Error(`IMG_HTTP_${direct.statusCode}/${viaProxy.statusCode}`);
  }
  return viaProxy;
}

async function fetchVercapas(slug) {
  const imageUrl = await getVercapasImageUrl(slug);
  const imgRes = await fetchVercapasImage(imageUrl);
  const filePath = path.join(COVERS_DIR, `${slug}.jpg`);
  await saveBody(imgRes, filePath);
}

function utcYmd(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return {
    yyyy: d.getUTCFullYear(),
    mm: String(d.getUTCMonth() + 1).padStart(2, '0'),
    dd: String(d.getUTCDate()).padStart(2, '0'),
  };
}

// kiosko.net serves front pages fine from datacenter IPs (unlike vercapas), so
// it works both as the primary source for El País and as a backup for the few
// Portuguese titles it carries. Note kiosko's slugs differ (e.g. a_bola) and it
// only publishes a handful of PT papers. Falls back to yesterday's date on 404.
async function fetchKiosko(section, kioskoSlug, outSlug) {
  let lastStatus = 'ERR';
  for (let offset = 0; offset <= 1; offset++) {
    const { yyyy, mm, dd } = utcYmd(offset);
    let imgRes;
    try {
      imgRes = await httpsGet({
        hostname: 'img.kiosko.net',
        path: `/${yyyy}/${mm}/${dd}/${section}/${kioskoSlug}.750.jpg`,
        method: 'GET',
        headers: browserHeaders({
          'Referer': 'https://en.kiosko.net/',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Sec-Fetch-Dest': 'image',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'cross-site',
        }),
      });
    } catch (err) {
      if (offset === 1) throw err;
      continue;
    }

    if (imgRes.statusCode === 200) {
      await saveBody(imgRes, path.join(COVERS_DIR, `${outSlug}.jpg`));
      return;
    }

    imgRes.resume();
    lastStatus = imgRes.statusCode;
    // 404 for today → the edition may not be up yet, try yesterday.
    if (imgRes.statusCode === 404 && offset === 0) continue;
    throw new Error(`KIOSKO_HTTP_${imgRes.statusCode}`);
  }
  throw new Error(`KIOSKO_HTTP_${lastStatus}`);
}

// kiosko carries only these PT titles (its slugs differ); it's the last resort.
const KIOSKO_BACKUP = {
  publico: { section: 'pt', slug: 'publico' },
  'a-bola': { section: 'pt', slug: 'a_bola' },
};

// Each publication maps to an ordered list of sources; the first that succeeds
// wins, so a flaky source is backed by the next. Order: sapo (primary, full
// coverage, datacenter-native) → vercapas via jina → kiosko.
function sourcesFor(outSlug) {
  const sources = [];
  if (SAPO_PUBS[outSlug]) {
    sources.push({ name: 'sapo', run: () => fetchSapo(outSlug) });
  }
  if (VERCAPAS_SLUGS.includes(outSlug)) {
    sources.push({ name: 'vercapas', run: () => fetchVercapas(outSlug) });
  }
  if (KIOSKO_BACKUP[outSlug]) {
    const k = KIOSKO_BACKUP[outSlug];
    sources.push({ name: 'kiosko', run: () => fetchKiosko(k.section, k.slug, outSlug) });
  }
  if (outSlug === 'elpais') {
    sources.push({ name: 'kiosko', run: () => fetchKiosko('es', 'elpais', 'elpais') });
  }
  return sources;
}

// Try each source in order until one saves the cover; aggregate errors so a
// total failure reports why every source failed.
async function fetchCover(outSlug) {
  const sources = sourcesFor(outSlug);
  if (sources.length === 0) throw new Error('NO_SOURCES');
  const errors = [];
  for (const source of sources) {
    try {
      await source.run();
      return source.name;
    } catch (err) {
      errors.push(`${source.name}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

async function runPool(tasks, concurrency) {
  let next = 0;
  const results = [];
  async function worker() {
    while (next < tasks.length) {
      const { slug } = tasks[next++];
      try {
        const via = await fetchCover(slug);
        console.log(`✓ ${slug} (${via})`);
        results.push(true);
      } catch (err) {
        console.error(`✗ ${slug}: ${err.message}`);
        results.push(false);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  fs.mkdirSync(COVERS_DIR, { recursive: true });

  const tasks = [...VERCAPAS_SLUGS, 'elpais'].map(slug => ({ slug }));

  // Cap concurrency so we don't burst all requests at the jina reader's
  // per-IP rate limit at once; retries in getVercapasImageUrl absorb the rest.
  const results = await runPool(tasks, 4);

  const failed = results.filter(ok => !ok).length;
  if (failed > 0) process.exitCode = 1;
}

main();
