import { createReservation, loadConfig, json, err } from '../../lib/core.js';

const MAX_BODY_BYTES = 4096;

export async function onRequestPost({ request, env }) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return err(413, 'BODY_TOO_LARGE', 'الطلب كبير جدًا.');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return err(413, 'BODY_TOO_LARGE', 'الطلب كبير جدًا.');
  let body;
  try { body = JSON.parse(text); } catch { return err(400, 'INVALID_JSON', 'صيغة الطلب غير صحيحة.'); }
  try {
    const cfg = await loadConfig(env.DB, env);
    const result = await createReservation(env.DB, cfg, body);
    return json(result.body, result.status);
  } catch (e) {
    console.error('reservation failed:', e);
    return err(500, 'DATABASE_ERROR', 'حدث خطأ في قاعدة البيانات.');
  }
}

export function onRequest() { return err(405, 'METHOD_NOT_ALLOWED', 'الطريقة غير مسموحة.'); }
