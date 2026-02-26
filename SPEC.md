# Portuguese Newspaper Front Pages Dashboard — SPEC

## Goal

Build a daily monitoring dashboard that displays the front page covers of Portuguese newspapers and magazines, updated automatically each day.

---

## Primary Data Source: vercapas.com

**vercapas.com** is the only source that covers all required publications in one place, including business papers, magazines, regionals, and satirical weeklies.

- Stable page URL pattern: `https://www.vercapas.com/capa/{slug}.html`
- These pages always show the latest available cover
- Full-size image URL is embedded in the page HTML and follows this pattern:
  `https://imgs.vercapas.com/covers/{slug}/YYYY/{slug}-YYYY-MM-DD-{hash}.jpg`
- Thumbnail URL (smaller): same but with `/th/` before the filename

### ⚠️ Critical: Hotlink Protection

`imgs.vercapas.com` uses **hotlink protection** — images return 403 Forbidden when embedded directly from another domain. Images must be **proxied or downloaded** before use. Do not use the `imgs.vercapas.com` URLs directly in `<img>` tags on your site.

---

## Publication Slugs

### General Press

| Publication | Slug | Frequency |
|---|---|---|
| Público | `publico` | Daily |
| Diário de Notícias | `diario-de-noticias` | Daily |
| Jornal de Notícias | `jornal-de-noticias` | Daily |
| Correio da Manhã | `correio-da-manha` | Daily |
| Expresso | `expresso` | Weekly (Friday) |

### Business

| Publication | Slug | Frequency |
|---|---|---|
| Jornal de Negócios | `jornal-de-negocios` | Daily |
| O Jornal Económico | `jornal-economico` | Daily |

### Sports

| Publication | Slug | Frequency |
|---|---|---|
| A Bola | `a-bola` | Daily |
| Record | `record` | Daily |
| O Jogo | `o-jogo` | Daily |

### Magazines

| Publication | Slug | Frequency |
|---|---|---|
| Visão | `visao` | Weekly (Thursday) |
| Sábado | `sabado` | Weekly |
| O Diabo | `o-diabo` | Weekly (Friday) |

### Regional

| Publication | Slug | Frequency |
|---|---|---|
| Açoriano Oriental | `acoriano-oriental` | Daily |
| Correio do Minho | `correio-do-minho` | Daily |

### International

| Publication | Source | Notes |
|---|---|---|
| El País | `https://en.kiosko.net/es/np/elpais.html` | Not on vercapas; use kiosko.net slug `elpais` (no underscore or hyphen) |

---

## Not Available (confirmed)

The following supplements do not have standalone front page images on any aggregator — they only exist inside the parent paper's e-paper:

- **P2** (Público supplement)
- **Notícias Magazine** (JN supplement)
- **Economia** (Expresso supplement)
- **Imobiliário** (Público supplement)

---

## How to Extract Today's Image URL

Fetch the vercapas page and extract the image URL with a regex:

### Python
```python
import requests, re

def get_cover_url(slug):
    html = requests.get(f"https://www.vercapas.com/capa/{slug}.html").text
    match = re.search(
        rf"covers/{slug}/\d+/{slug}-[\d-]+[a-f0-9]+\.jpg",
        html
    )
    if match:
        return f"https://imgs.vercapas.com/{match.group(0)}"
    return None
```

### Node.js
```js
async function getCoverUrl(slug) {
  const res = await fetch(`https://www.vercapas.com/capa/${slug}.html`);
  const html = await res.text();
  const match = html.match(
    new RegExp(`covers/${slug}/\\d+/${slug}-[\\d-]+[a-f0-9]+\\.jpg`)
  );
  return match ? `https://imgs.vercapas.com/${match[0]}` : null;
}
```

---

## Recommended Implementation: Daily Cron + Local Files

The most robust approach is a daily cron/scheduled job that downloads all covers locally. This gives fast page loads and zero runtime dependency on vercapas.

### Bash script (run daily at ~7:00 AM via cron)
```bash
#!/bin/bash
SLUGS=(
  publico correio-da-manha jornal-de-noticias diario-de-noticias
  expresso jornal-de-negocios jornal-economico
  a-bola record o-jogo
  visao sabado o-diabo
  acoriano-oriental correio-do-minho
)

mkdir -p covers

for SLUG in "${SLUGS[@]}"; do
  URL=$(curl -s "https://www.vercapas.com/capa/${SLUG}.html" \
    | grep -oP "https://imgs\.vercapas\.com/covers/${SLUG}/\d+/${SLUG}-[\d-]+[a-f0-9]+\.jpg" \
    | head -1)

  if [ -n "$URL" ]; then
    curl -s -o "covers/${SLUG}.jpg" "$URL"
    echo "✓ ${SLUG}"
  else
    echo "✗ ${SLUG}: not found"
  fi
done
```

Then reference covers as: `<img src="covers/publico.jpg">`

---

## Alternative: Real-Time Proxy

If you can't run a cron job, proxy image requests through your own server at runtime.

### PHP proxy (`proxy.php`)
```php
<?php
$slug = preg_replace('/[^a-z-]/', '', $_GET['slug'] ?? '');
if (!$slug) die('invalid');

$html = file_get_contents("https://www.vercapas.com/capa/{$slug}.html");
preg_match('/covers\/' . preg_quote($slug, '/') . '\/\d+\/' . preg_quote($slug, '/') . '-[\d-]+[a-f0-9]+\.jpg/', $html, $m);
if (!$m) http_response_code(404) && die('not found');

header('Content-Type: image/jpeg');
header('Cache-Control: max-age=3600');
readfile("https://imgs.vercapas.com/" . $m[0]);
```

Use as: `<img src="proxy.php?slug=publico">`

### Cloudflare Worker
```js
export default {
  async fetch(req) {
    const slug = new URL(req.url).searchParams.get('slug')?.replace(/[^a-z-]/g, '');
    if (!slug) return new Response('invalid', { status: 400 });

    const page = await fetch(`https://www.vercapas.com/capa/${slug}.html`);
    const html = await page.text();
    const match = html.match(
      new RegExp(`covers/${slug}/\\d+/${slug}-[\\d-]+[a-f0-9]+\\.jpg`)
    );
    if (!match) return new Response('not found', { status: 404 });

    const img = await fetch(`https://imgs.vercapas.com/${match[0]}`, {
      headers: { Referer: 'https://www.vercapas.com/' }
    });
    return new Response(img.body, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' }
    });
  }
};
```

---

## Secondary Source: frontpages.com

Covers the 8 main titles only. Image filenames contain a daily hash and are not predictable — usable for verification but not for automation.

Available: Público, Diário de Notícias, Jornal de Notícias, Correio da Manhã, Expresso, A Bola, Record, O Jogo.

---

## Secondary Source: kiosko.net

- Image pattern: `https://img.kiosko.net/YYYY/MM/DD/pt/{slug}.750.jpg`
- Page pattern: `https://en.kiosko.net/pt/np/{slug}.html`
- Also uses hotlink protection in some configurations
- El País (Spain): `https://img.kiosko.net/YYYY/MM/DD/es/elpais.750.jpg`

### Kiosko slugs for Portuguese titles
| Publication | Slug |
|---|---|
| Público | `publico` |
| Diário de Notícias | `diario_noticias` |
| Jornal de Notícias | *(not confirmed — not reliably indexed)* |
| Correio da Manhã | `correiodamanha` |
| Expresso | `expresso` |
| Jornal de Negócios | `jornaldenegocios` |
| A Bola | `a_bola` |
| Record | `pt_record` |
| O Jogo | `o_jogo` |
| El País | `elpais` (country: `es`) |
