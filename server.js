'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const VERCAPAS_SLUGS = new Set([
  'publico', 'diario-de-noticias', 'jornal-de-noticias', 'correio-da-manha', 'expresso',
  'jornal-de-negocios', 'jornal-economico',
  'a-bola', 'record', 'o-jogo',
  'visao', 'sabado', 'o-diabo',
  'acoriano-oriental', 'correio-do-minho',
]);

const ALL_SLUGS = new Set([...VERCAPAS_SLUGS, 'elpais']);

// In-memory URL cache: slug -> { imageUrl, cachedAt }
const urlCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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

async function getVercapasImageUrl(slug) {
  const cached = urlCache.get(slug);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.imageUrl;
  }

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

  const imageUrl = `https://imgs.vercapas.com/${match[0]}`;
  urlCache.set(slug, { imageUrl, cachedAt: Date.now() });
  return imageUrl;
}

function getKioskoUrl(dateOffsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - dateOffsetDays);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `https://img.kiosko.net/${yyyy}/${mm}/${dd}/es/elpais.750.jpg`;
}

async function proxyVercapas(slug, res) {
  let imageUrl;
  try {
    imageUrl = await getVercapasImageUrl(slug);
  } catch (err) {
    if (err.message === 'TIMEOUT') {
      res.writeHead(504); res.end('Gateway Timeout');
    } else if (err.message === 'NO_MATCH') {
      res.writeHead(404); res.end('Cover not available');
    } else {
      res.writeHead(502); res.end('Bad Gateway');
    }
    return;
  }

  let imgRes;
  try {
    const u = new URL(imageUrl);
    imgRes = await httpsGet({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        'Referer': 'https://www.vercapas.com/',
        'User-Agent': 'Mozilla/5.0 (compatible)',
      },
    });
  } catch (err) {
    if (err.message === 'TIMEOUT') {
      res.writeHead(504); res.end('Gateway Timeout');
    } else {
      res.writeHead(502); res.end('Bad Gateway');
    }
    return;
  }

  if (imgRes.statusCode !== 200) {
    res.writeHead(imgRes.statusCode);
    imgRes.resume();
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-store',
  });
  imgRes.pipe(res);
  imgRes.on('error', () => res.destroy());
}

async function proxyElPais(res) {
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
      if (err.message === 'TIMEOUT') {
        res.writeHead(504); res.end('Gateway Timeout');
        return;
      }
      continue;
    }

    if (imgRes.statusCode === 404) {
      imgRes.resume();
      if (offset === 0) continue; // retry with yesterday
      res.writeHead(404); res.end('Cover not available');
      return;
    }

    if (imgRes.statusCode !== 200) {
      res.writeHead(imgRes.statusCode);
      imgRes.resume();
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store',
    });
    imgRes.pipe(res);
    imgRes.on('error', () => res.destroy());
    return;
  }

  res.writeHead(404); res.end('Cover not available');
}

async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, `http://localhost`);

  if (req.method === 'GET' && pathname === '/') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  const coverMatch = pathname.match(/^\/cover\/([a-z0-9-]+)$/);
  if (req.method === 'GET' && coverMatch) {
    const slug = coverMatch[1];
    if (!ALL_SLUGS.has(slug)) {
      res.writeHead(400);
      res.end('Invalid slug');
      return;
    }
    if (slug === 'elpais') {
      await proxyElPais(res);
    } else {
      await proxyVercapas(slug, res);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Jornais running at http://localhost:${PORT}`);
});
