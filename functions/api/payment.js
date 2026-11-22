// GET /api/payment?ref=MSD-XXXXXX&tok=<REVIEW_TOKEN>
// Returns the stored screenshot as raw bytes. Token-gated, no-store, image-only.
// Kept separate from /review so the list page never inlines hundreds of images.
import { safeEqual, SQL } from '../../lib/core.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });

  const token = String(env.REVIEW_TOKEN ?? '');
  if (!token) return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });

  const url = new URL(request.url);
  if (!safeEqual(url.searchParams.get('tok') || '', token))
    return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });

  const ref = url.searchParams.get('ref') || '';
  if (!/^[A-Za-z0-9-]{4,40}$/.test(ref)) return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });

  const row = await env.DB.prepare(SQL.paymentImage).bind(ref).first();
  const data = row && row.payment_image;
  if (!data) return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });

  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!m) return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });

  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': m[1],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="${ref}.jpg"`,
    },
  });
}
