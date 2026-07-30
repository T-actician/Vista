import { AwsClient } from 'aws4fetch';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1)); // e.g. photos/xxx.jpg

    if (!key || !(key.startsWith('photos/') || key.startsWith('thumbs/'))) {
      return new Response('Not found', { status: 404 });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    // Only trust a cached entry if it already has the CORS header — older
    // cached responses (from before this header existed) are immutable for
    // a year and won't self-update on their own, so we bypass and refetch.
    if (cached && cached.headers.get('Access-Control-Allow-Origin')) return cached;

    const aws = new AwsClient({
      accessKeyId: env.B2_KEY_ID,
      secretAccessKey: env.B2_APP_KEY,
      service: 's3',
      region: 'auto',
    });

    const b2Url = `https://${env.B2_ENDPOINT}/${env.B2_BUCKET}/${key}`;
    const signedReq = await aws.sign(b2Url, { method: 'GET' });
    const b2res = await fetch(signedReq);
    if (!b2res.ok) return new Response('Not found', { status: b2res.status });

    const dl = url.searchParams.get('dl');
    const headers = new Headers();
    headers.set('Content-Type', b2res.headers.get('Content-Type') || 'image/jpeg');
    // Filenames are timestamped/unique per upload, so content at a given key
    // never changes — safe to cache indefinitely, both at the edge and in browsers.
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');
    if (dl) headers.set('Content-Disposition', `attachment; filename="${dl}"`);

    const response = new Response(b2res.body, { status: 200, headers });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};