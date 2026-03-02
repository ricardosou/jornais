import { createClient } from 'npm:@supabase/supabase-js@2';

const VERCAPAS_SLUGS = [
  'publico', 'diario-de-noticias', 'jornal-de-noticias', 'correio-da-manha', 'expresso',
  'jornal-de-negocios', 'jornal-economico',
  'a-bola', 'record', 'o-jogo',
  'visao', 'sabado', 'o-diabo',
  'acoriano-oriental', 'correio-do-minho',
];

async function scrapeVercapas(slug: string): Promise<string> {
  const res = await fetch(`https://www.vercapas.com/capa/${slug}.html`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', Accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`VERCAPAS_HTTP_${res.status}`);

  const html = await res.text();
  const pattern = new RegExp(`covers/${slug}/\\d+/${slug}-[\\d-]+[a-f0-9]+\\.jpg`);
  const match = html.match(pattern);
  if (!match) throw new Error('NO_MATCH');

  return `https://imgs.vercapas.com/${match[0]}`;
}

function getKioskoUrl(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `https://img.kiosko.net/${yyyy}/${mm}/${dd}/es/elpais.750.jpg`;
}

async function scrapeElPais(): Promise<string> {
  for (let offset = 0; offset <= 1; offset++) {
    const url = getKioskoUrl(offset);
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { Referer: 'https://en.kiosko.net/', 'User-Agent': 'Mozilla/5.0 (compatible)' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 && offset === 0) continue;
    if (!res.ok) throw new Error(`KIOSKO_HTTP_${res.status}`);
    return url;
  }
  throw new Error('KIOSKO_NOT_FOUND');
}

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const results: Record<string, { status: string; url?: string; error?: string }> = {};

  await Promise.allSettled([
    ...VERCAPAS_SLUGS.map(async (slug) => {
      try {
        const image_url = await scrapeVercapas(slug);
        const { error } = await supabase
          .from('covers')
          .upsert({ slug, image_url, refreshed_at: new Date() });
        if (error) throw error;
        const imgRes = await fetch(image_url, {
          headers: { Referer: 'https://www.vercapas.com/', 'User-Agent': 'Mozilla/5.0 (compatible)' },
          signal: AbortSignal.timeout(15000),
        });
        if (!imgRes.ok) throw new Error(`IMG_HTTP_${imgRes.status}`);
        const imgBytes = await imgRes.arrayBuffer();
        const { error: storageError } = await supabase.storage
          .from('bucket1')
          .upload(`covers/${slug}`, imgBytes, { contentType: 'image/jpeg', upsert: true });
        if (storageError) throw storageError;
        results[slug] = { status: 'ok', url: image_url };
      } catch (err) {
        results[slug] = { status: 'error', error: err instanceof Error ? err.message : JSON.stringify(err) };
      }
    }),
    (async () => {
      try {
        const image_url = await scrapeElPais();
        const { error } = await supabase
          .from('covers')
          .upsert({ slug: 'elpais', image_url, refreshed_at: new Date() });
        if (error) throw error;
        const imgRes = await fetch(image_url, {
          headers: { Referer: 'https://en.kiosko.net/', 'User-Agent': 'Mozilla/5.0 (compatible)' },
          signal: AbortSignal.timeout(15000),
        });
        if (!imgRes.ok) throw new Error(`IMG_HTTP_${imgRes.status}`);
        const imgBytes = await imgRes.arrayBuffer();
        const { error: storageError } = await supabase.storage
          .from('bucket1')
          .upload('covers/elpais', imgBytes, { contentType: 'image/jpeg', upsert: true });
        if (storageError) throw storageError;
        results['elpais'] = { status: 'ok', url: image_url };
      } catch (err) {
        results['elpais'] = { status: 'error', error: err instanceof Error ? err.message : JSON.stringify(err) };
      }
    })(),
  ]);

  return new Response(JSON.stringify(results, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
});
