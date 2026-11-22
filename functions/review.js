// GET /review?tok=<REVIEW_TOKEN>  — organizer verification screen. Read-only.
// No scripts, no writes, strict CSP. To change a status, run the SQL shown on each
// card in the D1 console (kept that way on purpose: zero authenticated write surface).
import { safeEqual, reviewList, EVENT } from '../lib/core.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtEgp = (p) => (p / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtTime = (ts, tz) => {
  try { return new Date(ts * 1000).toLocaleString('ar-EG', { timeZone: tz || EVENT.timezone, dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return new Date(ts * 1000).toISOString(); }
};
const STATUS = { pending_payment: ['بانتظار المراجعة', 'warn'], confirmed: ['مؤكَّد', 'ok'], cancelled: ['ملغى', 'off'] };

function card(r, token) {
  const [label, cls] = STATUS[r.status] || [r.status, 'off'];
  const img = r.has_image
    ? `<img class="shot" loading="lazy" decoding="async" alt="صورة دفع ${esc(r.id)}" src="/api/payment?ref=${encodeURIComponent(r.id)}&tok=${encodeURIComponent(token)}">`
    : `<div class="shot none">لا صورة</div>`;
  const tickets = (r.ticket_numbers || []).map(t => `<li dir="ltr">${esc(t)}</li>`).join('');
  const phone = r.customer_phone || '';
  const contact = phone
    ? `<a class="lnk" href="tel:+${esc(phone)}">اتصال</a> <a class="lnk wa" href="https://wa.me/${esc(phone)}?text=${encodeURIComponent('مرحبًا، بخصوص حجزك ' + r.id + ' في عرض مكتب حل المشاكل التافهة — تم استلام صورة الدفع وجاري المراجعة.')}">واتساب</a>`
    : '';
  return `<article class="card ${cls}">
    <header><code dir="ltr">${esc(r.id)}</code><span class="pill ${cls}">${esc(label)}</span></header>
    <div class="body">
      ${img}
      <dl>
        <div><dt>العرض</dt><dd>${esc(r.performance_id)}</dd></div>
        <div><dt>العدد</dt><dd>${esc(r.quantity)}</dd></div>
        <div><dt>المبلغ</dt><dd><b>${esc(fmtEgp(r.total_piasters))}</b> ج.م</dd></div>
        <div><dt>الاسم</dt><dd>${esc(r.customer_name || '—')}</dd></div>
        <div><dt>الموبايل</dt><dd dir="ltr">${esc(phone || '—')} ${contact}</dd></div>
        <div><dt>التوقيت</dt><dd>${esc(fmtTime(r.created_at))}</dd></div>
      </dl>
      <ul class="tk">${tickets}</ul>
    </div>
    <pre class="sql"><code>UPDATE reservations SET status='confirmed' WHERE id='${esc(r.id)}';</code></pre>
    <pre class="sql dim"><code>UPDATE reservations SET status='cancelled' WHERE id='${esc(r.id)}';</code></pre>
  </article>`;
}

export async function onRequest(context) {
  const { request, env } = context;
  const H = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer' };
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { ...H, allow: 'GET' } });

  const token = String(env.REVIEW_TOKEN ?? '');
  if (!token) return new Response('Not Found', { status: 404, headers: H });
  const url = new URL(request.url);
  if (!safeEqual(url.searchParams.get('tok') || '', token)) return new Response('Forbidden', { status: 403, headers: H });

  let rows;
  try { rows = await reviewList(env.DB); }
  catch (e) { console.error('review list failed:', e); return new Response('Database error', { status: 500, headers: H }); }

  const pending = rows.filter(r => r.status === 'pending_payment').length;
  const cards = rows.map(r => card(r, token)).join('') || '<p class="empty">لا حجوزات بعد.</p>';

  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>مراجعة الحجوزات — ${esc(EVENT.name)}</title>
<style>
:root{--red:#c0182c;--gold:#e3a82b;--paper:#ece0c4;--ink:#1a120b;--coal:#241a12;--dim:#cdbd97}
*{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--paper);font:15px/1.6 system-ui,"Segoe UI",Tahoma,sans-serif;padding:1rem}
h1{font-size:1.2rem;margin:.2rem 0;color:var(--gold)}
.bar{position:sticky;top:0;background:var(--coal);border:1px solid #3a2c1d;border-radius:10px;padding:.6rem .9rem;margin-bottom:1rem;display:flex;gap:1rem;flex-wrap:wrap;align-items:center}
.bar b{color:var(--gold)}.bar .n{color:var(--dim);font-size:.85rem}
.card{background:var(--coal);border:1px solid #3a2c1d;border-inline-start:4px solid var(--red);border-radius:12px;padding:.9rem 1rem;margin-bottom:.9rem}
.card.ok{border-inline-start-color:#1f9d57}.card.off{border-inline-start-color:#6b5a42;opacity:.8}
.card header{display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.6rem}
code{font-family:ui-monospace,"Courier New",monospace;background:rgba(0,0,0,.3);padding:.1rem .4rem;border-radius:6px;font-size:.85rem}
.pill{font-size:.72rem;padding:.15rem .55rem;border-radius:999px;border:1px solid}
.pill.warn{color:#f3d9cc;border-color:var(--red);background:#4a1c20}.pill.ok{color:#bfe3c6;border-color:#2e5d3a;background:#1c3324}.pill.off{color:#e9dcc4;border-color:#6b5a42;background:#2c2016}
.body{display:grid;grid-template-columns:140px 1fr;gap:.9rem;align-items:start}
.shot{width:140px;height:180px;object-fit:cover;border-radius:8px;border:1px solid #3a2c1d;background:#000;display:block}
.shot.none{display:grid;place-items:center;color:var(--dim);font-size:.8rem}
dl{margin:0;display:grid;gap:.25rem}dl div{display:flex;gap:.5rem;flex-wrap:wrap}dt{color:var(--dim);min-width:5.5em}dd{margin:0}
.tk{list-style:none;display:flex;flex-wrap:wrap;gap:.35rem;padding:0;margin:.5rem 0 0}
.tk li{font-family:ui-monospace,monospace;font-size:.78rem;border:1px dashed #5f4426;border-radius:6px;padding:.1rem .45rem;background:var(--ink)}
.lnk{color:var(--gold);text-decoration:none;font-size:.8rem;border:1px solid #5f4426;border-radius:6px;padding:.05rem .45rem;margin-inline-start:.3rem}
.lnk.wa{color:#bfe3c6;border-color:#2e5d3a}
.sql{margin:.6rem 0 0;background:var(--ink);border:1px solid #3a2c1d;border-radius:8px;padding:.5rem .7rem;overflow:auto}
.sql code{background:none;padding:0;font-size:.78rem;color:var(--gold);direction:ltr;display:block;text-align:left}
.sql.dim code{color:var(--dim)}
.empty{color:var(--dim);text-align:center;padding:2rem}
@media(max-width:560px){.body{grid-template-columns:1fr}.shot{width:100%;height:200px}}
</style></head><body>
<h1>مراجعة الحجوزات — ${esc(EVENT.name)}</h1>
<div class="bar"><span>الإجمالي: <b>${rows.length}</b></span><span>بانتظار المراجعة: <b>${pending}</b></span><span class="n">اضغط على الصورة لفتحها بالحجم الكامل • لتغيير الحالة شغّل السطر البرمجي في الد1</span></div>
${cards}
</body></html>`;

  return new Response(html, { status: 200, headers: { ...H, 'content-type': 'text/html; charset=utf-8' } });
}
