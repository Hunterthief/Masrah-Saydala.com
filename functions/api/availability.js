import { availabilityPayload, loadConfig, json, err } from '../../lib/core.js';

export async function onRequestGet({ env }) {
  try {
    const cfg = await loadConfig(env.DB, env);
    return json(await availabilityPayload(env.DB, cfg));
  } catch (e) {
    console.error('availability failed:', e);
    return err(500, 'DATABASE_ERROR', 'حدث خطأ في قاعدة البيانات.');
  }
}

export function onRequest() { return err(405, 'METHOD_NOT_ALLOWED', 'الطريقة غير مسموحة.'); }
