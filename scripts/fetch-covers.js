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

const COVERS_DIR = path.join(__dirname, '..', 'covers');

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

async function getVercapasImageUrl(slug) {
  let res;
  try {
    res = await httpsGet({
      hostname: 'www.vercapas.com',
      path: `/capa/${slug}.html`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible)',
        'Accept': 'text/html',
      },
    });
  } catch (err) {
    throw err.message === 'TIMEOUT' ? err : new Error('UPSTREAM_ERROR');
  }

  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`VERCAPAS_HTTP_${res.statusCode}`);
  }

  let html;
  try {
    html = await readBody(res);
  } catch {
    throw new Error('UPSTREAM_ERROR');
  }

  const pattern = new RegExp(`covers/${slug}/\\d+/${slug}-[\\d-]+[a-f0-9]+\\.jpg`);
  const match = html.match(pattern);
  if (!match) throw new Error('NO_MATCH');

  return `https://imgs.vercapas.com/${match[0]}`;
}

async function fetchVercapas(slug) {
  const imageUrl = await getVercapasImageUrl(slug);
  const u = new URL(imageUrl);
  const imgRes = await httpsGet({
    hostname: u.hostname,
    path: u.pathname + (u.search || ''),
    method: 'GET',
    headers: {
      'Referer': 'https://www.vercapas.com/',
      'User-Agent': 'Mozilla/5.0 (compatible)',
    },
  });

  if (imgRes.statusCode !== 200) {
    imgRes.resume();
    throw new Error(`IMG_HTTP_${imgRes.statusCode}`);
  }

  const filePath = path.join(COVERS_DIR, `${slug}.jpg`);
  await saveBody(imgRes, filePath);
}

function getKioskoUrl(dateOffsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - dateOffsetDays);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `https://img.kiosko.net/${yyyy}/${mm}/${dd}/es/elpais.750.jpg`;
}

async function fetchElPais() {
  for (let offset = 0; offset <= 1; offset++) {
    const imgUrl = getKioskoUrl(offset);
    const u = new URL(imgUrl);
    let imgRes;
    try {
      imgRes = await httpsGet({
        hostname: u.hostname,
        path: u.pathname,
        method: 'GET',
        headers: {
          'Referer': 'https://en.kiosko.net/',
          'User-Agent': 'Mozilla/5.0 (compatible)',
        },
      });
    } catch (err) {
      if (offset === 1) throw err;
      continue;
    }

    if (imgRes.statusCode === 404) {
      imgRes.resume();
      if (offset === 0) continue;
      throw new Error('ELPAIS_NOT_FOUND');
    }

    if (imgRes.statusCode !== 200) {
      imgRes.resume();
      throw new Error(`ELPAIS_HTTP_${imgRes.statusCode}`);
    }

    const filePath = path.join(COVERS_DIR, 'elpais.jpg');
    await saveBody(imgRes, filePath);
    return;
  }
  throw new Error('ELPAIS_NOT_FOUND');
}

async function main() {
  fs.mkdirSync(COVERS_DIR, { recursive: true });

  const tasks = [
    ...VERCAPAS_SLUGS.map(slug => ({ slug, fn: () => fetchVercapas(slug) })),
    { slug: 'elpais', fn: fetchElPais },
  ];

  await Promise.all(tasks.map(async ({ slug, fn }) => {
    try {
      await fn();
      console.log(`✓ ${slug}`);
    } catch (err) {
      console.error(`✗ ${slug}: ${err.message}`);
    }
  }));
}

main();
