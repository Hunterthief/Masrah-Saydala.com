import { availabilityPayload, readConfig, json, err } from '../../lib/core.js';

export async function onRequestGet({ env }) {
  try { return json(await availabilityPayload(env.DB, readConfig(env))); }
  catch (e) { console.error('availability failed:', e); return err(500, 'DATABASE_ERROR', 'حدث خطأ في قاعدة البيانات.'); }
}

// Any non-GET method.
export function onRequest() { return err(405, 'METHOD_NOT_ALLOWED', 'الطريقة غير مسموحة.'); }
