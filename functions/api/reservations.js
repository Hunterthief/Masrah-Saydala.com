// POST /api/reservations — the ONLY write endpoint. A booking + its compressed
// InstaPay screenshot are created atomically, and only when the customer presses
// "سجّل الحجز وأرفق صورة الدفع" with a valid image attached.
import { loadConfig, createReservation, json, err } from '../../lib/core.js';

const MAX_BODY_BYTES = 700 * 1024; // compressed image (~270KB raw) + json overhead

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'طريقة غير مسموحة.');

  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) return err(413, 'BODY_TOO_LARGE', 'الحجم المرفوع كبير جدًا.');

  let body;
  try { body = await request.json(); }
  catch { return err(400, 'INVALID_JSON', 'جسم الطلب غير صالح.'); }

  const cfg = await loadConfig(env.DB, env);
  const result = await createReservation(env.DB, cfg, body);
  return json(result.body, result.status);
}
