// Masrah Saydala — purchase page logic (vanilla ES module, no dependencies).
//
// Flow contract:
//   Step 1  choose show / qty / name / phone          -> no network, no DB
//   Step 2  "متابعة إلى الدفع" (continueToPayment)     -> payment panel + upload slot, STILL no DB
//   Step 3  attach screenshot (client-compressed)      -> still no DB, just a local preview
//   Step 4  "سجّل الحجز وأرفق صورة الدفع" (#pay-submit) -> the ONLY POST /api/reservations
//
// The screenshot is downscaled + re-encoded on-device via <canvas> before upload:
// that keeps it inside D1's per-request budget AND sanitizes it (EXIF/payload stripped).
// No WhatsApp, no popups, no countdown, no expiry figure.

import { formatEGP, formatTime, formatDateAr, normalizePhone } from './format.js';

document.documentElement.classList.add('js');

const $ = (id) => document.getElementById(id);
const toggle = (id, isHidden) => { const el = $(id); if (el) el.hidden = isHidden; };
const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };

const AUTO_FOCUS = true;          // false = keep auto-scroll, stop focus-stealing
const CAP_CHARS = 360_000;        // must match core.MAX_IMAGE_CHARS
const RAW_LIMIT = 8 * 1024 * 1024; // reject absurd originals before processing

const state = {
  data: null, selected: null, qty: 1,
  pending: false, reservation: null,
  customerName: '', customerPhone: '',
  paymentImage: null,             // data-URI, set only after a successful compress
  imageName: '', imageKb: 0,
  key: null, keySig: null, clockOffset: 0, submitting: false,
};

const perfEls = { A: $('perf-A'), B: $('perf-B') };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const announce = (msg) => setText('status-live', msg);
const perfById = (id) => state.data?.performances.find((p) => p.id === id);

function goTo(el, focusSel) {
  if (!el) return;
  el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  if (AUTO_FOCUS && focusSel) ($(focusSel) || document.querySelector(focusSel))?.focus({ preventScroll: true });
}

// Quantity is bounded only by remaining seats now (no per-booking business cap).
function maxQty() {
  const p = perfById(state.selected);
  if (!p) return 1;
  return Math.max(1, p.available);
}

async function loadAvailability() {
  try {
    const res = await fetch('/api/availability', { headers: { accept: 'application/json' } });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error?.code || 'BAD_RESPONSE');
    state.clockOffset = (Date.parse(data.server_time) - Date.now()) / 1000;
    state.data = data;
    toggle('load-status', true);
    render();
  } catch {
    const el = $('load-status');
    if (el) { el.hidden = false; el.textContent = 'تعذر تحميل حالة التذاكر. اضغط «تحديث المتاح» للمحاولة مجددًا.'; }
  }
}

function updateHeadStatus() {
  const d = state.data, pill = $('head-status');
  if (!pill) return;
  if (!d) { pill.textContent = 'جارٍ التحقق…'; pill.className = 'head-pill idle'; return; }
  if (d.config.test_mode) { pill.textContent = 'وضع الاختبار'; pill.className = 'head-pill test'; }
  else if (d.booking_open) { pill.textContent = 'الحجز مفتوح'; pill.className = 'head-pill open'; }
  else { pill.textContent = 'الحجز مغلق'; pill.className = 'head-pill closed'; }
}

function updateFlow() {
  const hasSel = !!state.selected, pending = !!state.pending, done = !!state.reservation;
  const attached = !!state.paymentImage;
  document.querySelectorAll('#flow li').forEach((li, i) => {
    const n = i + 1; let cls = '';
    if (n === 1) cls = hasSel ? 'done' : 'active';
    else if (n === 2) cls = (pending || done) ? 'done' : (hasSel ? 'active' : '');
    else if (n === 3) cls = (attached || done) ? 'done' : (pending ? 'active' : '');
    else cls = done ? 'active' : (attached ? 'active' : '');
    li.className = cls;
  });
}

function render() {
  const d = state.data; if (!d) return;
  toggle('closed-banner', !d.booking_open);
  toggle('test-banner', !d.config.test_mode);
  updateHeadStatus();

  if (d.config.whatsapp_number) {
    const a = $('contact-wa');
    if (a) { a.href = `https://wa.me/${d.config.whatsapp_number}`; a.hidden = false; }
    toggle('contact-missing', true);
  }

  for (const p of d.performances) {
    const el = perfEls[p.id]; if (!el) continue;
    el.querySelector('.perf-date').textContent = formatDateAr(p.event_date);
    el.querySelector('.perf-doors').textContent = formatTime(p.doors_open);
    el.querySelector('.perf-starts').textContent = formatTime(p.starts_at);
    el.querySelector('.perf-price').textContent = p.configured ? `${formatEGP(p.price_piasters)} ج.م` : 'يُعلن لاحقًا';
    el.querySelector('.perf-available').textContent = p.configured ? `${p.available} تذكرة` : '—';
    const badge = el.querySelector('.perf-badge');
    if (p.bookable) { badge.textContent = 'متاح للحجز'; badge.className = 'perf-badge ok'; }
    else if (p.configured && p.available <= 0) { badge.textContent = 'اكتمل العدد'; badge.className = 'perf-badge soldout'; }
    else { badge.textContent = 'غير متاح بعد'; badge.className = 'perf-badge off'; }
    el.disabled = !p.bookable || state.pending || !!state.reservation;
    el.setAttribute('aria-pressed', String(state.selected === p.id));
    el.classList.toggle('selected', state.selected === p.id);
  }

  if (state.selected && !perfById(state.selected)?.bookable) {
    state.selected = null;
    if (state.pending && !state.reservation) { state.pending = false; toggle('payment', true); }
  }
  if (state.selected && !state.pending && !state.reservation) setQty(Math.min(state.qty, maxQty()));

  applyInteractionState();
  renderSummary();
  updateFlow();
}

function applyInteractionState() {
  const open = !!state.data?.booking_open && !!state.selected && !state.pending && !state.reservation;
  const fs = $('booking-fieldset'); if (fs) fs.disabled = !open;

  const btn = $('book-btn');
  if (btn) {
    btn.disabled = !open || state.submitting;
    btn.textContent = state.submitting ? 'جارٍ التحضير…' : 'متابعة إلى الدفع';
    btn.classList.toggle('ready', open && !!normalizePhone($('phone-input')?.value || '') && !state.submitting);
  }

  const att = $('pay-image-btn');
  if (att) att.disabled = !state.pending || !!state.reservation || state.submitting;

  const sub = $('pay-submit');
  if (sub) {
    const locked = !!state.reservation;
    sub.disabled = locked || state.submitting || !state.pending || !state.paymentImage;
    sub.classList.toggle('ready', state.pending && !state.submitting && !!state.paymentImage && !locked);
    if (locked) { sub.hidden = true; att && (att.hidden = true); }
  }
}

function selectPerformance(id) {
  if (state.pending || state.reservation) return;
  state.selected = id; state.qty = 1; hideError(); render();
  announce(`تم اختيار ${perfById(id).name}`);
  goTo($('booking-fieldset'), '#name-input');   // name first, then number
}

function setQty(n) {
  state.qty = Math.min(Math.max(1, n), maxQty());
  setText('qty-value', state.qty);
  const minus = $('qty-minus'), plus = $('qty-plus');
  if (minus) minus.disabled = state.qty <= 1;
  if (plus) plus.disabled = state.qty >= maxQty();
  renderSummary();
}

function renderSummary() {
  const p = perfById(state.selected);
  if (!p) { for (const id of ['sum-perf','sum-qty','sum-unit','sum-total']) setText(id,'—'); setText('qty-hint',''); return; }
  setText('sum-perf', `${p.name} (${p.id}) — ${formatTime(p.starts_at)}`);
  setText('sum-qty', state.qty);
  setText('sum-unit', `${formatEGP(p.price_piasters)} ج.م`);
  setText('sum-total', `${formatEGP(p.price_piasters * state.qty)} ج.م`);
  setText('qty-hint', `المتاح لهذا العرض: ${p.available} تذكرة`);   // no per-booking max anymore
}

function showError(msg) {
  const inPanel = !$('payment')?.hidden;
  const active = $(inPanel ? 'pay-error' : 'book-error');
  const other = $(inPanel ? 'book-error' : 'pay-error');
  if (other) other.hidden = true;
  if (active) { active.textContent = msg; active.hidden = false; }
}
function hideError() { toggle('book-error', true); toggle('pay-error', true); }

/* STEP 2 — validation + panel only. ZERO writes. */
function continueToPayment() {
  if (state.pending || state.reservation) return;
  if (!state.selected) { showError('اختر العرض أولًا.'); return; }
  const phoneInput = $('phone-input');
  const phone = phoneInput ? normalizePhone(phoneInput.value) : null;
  if (!phone) { showError('من فضلك أدخل رقم موبايل صحيح لمطابقة الدفع (مثال: 01012345678).'); phoneInput?.focus(); return; }

  state.customerPhone = phone;
  state.customerName = ($('name-input')?.value || '').trim();
  state.pending = true;
  hideError();
  renderPendingPanel();
  render();
  announce('حوّل المبلغ ثم أرفق صورة الدفع. لا يُسجَّـل الحجز إلا عند ضغط زر التسجيل.');
  goTo($('payment'), '#pay-image-btn');   // auto-progress to the attach control
}

function renderPendingPanel() {
  const p = perfById(state.selected), cfg = state.data.config; if (!p) return;
  const pay = $('payment');
  if (pay) { pay.hidden = false; pay.style.animation = 'none'; void pay.offsetWidth; pay.style.animation = ''; }

  toggle('pay-pending', false);
  toggle('pay-committed', true);
  toggle('pay-test', !cfg.test_mode);

  setText('pay-perf', `${p.name} (${p.id}) — ${formatTime(p.starts_at)}`);
  setText('pay-qty', state.qty);
  setText('pay-name', state.customerName || '—');
  setText('pay-phone', state.customerPhone);
  setText('pay-amount', formatEGP(p.price_piasters * state.qty));

  const noDetails = cfg.test_mode && !cfg.instapay_address;
  toggle('instapay-block', noDetails);
  if (!noDetails) setText('pay-instapay', cfg.instapay_address);

  const att = $('pay-image-btn'); if (att) { att.hidden = false; att.disabled = false; att.textContent = 'اختيار صورة التحويل'; }
  const sub = $('pay-submit'); if (sub) { sub.hidden = false; sub.disabled = !state.paymentImage; sub.textContent = 'سجّل الحجز وأرفق صورة الدفع'; }
  toggle('pay-image-preview', !state.paymentImage);
  if (state.paymentImage) showPreview();

  const nb = $('new-booking'); if (nb) nb.textContent = 'تعديل الحجز';
}

/* ---- on-device image pipeline: validate -> downscale -> re-encode -> preview ---- */
function loadImage(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('LOAD')); i.src = url; });
}
async function compressImage(file) {
  if (!file) return null;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('TYPE');
  if (file.size > RAW_LIMIT) throw new Error('TOO_BIG');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const ladder = [[1280, .72], [1024, .64], [820, .58], [640, .52]];
    for (const [maxDim, q] of ladder) {
      const s = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * s));
      const h = Math.max(1, Math.round(img.naturalHeight * s));
      canvas.width = w; canvas.height = h;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);   // flatten alpha for JPEG
      ctx.drawImage(img, 0, 0, w, h);
      let d = canvas.toDataURL('image/jpeg', q);
      if (!/^data:image\/jpeg;base64,/.test(d)) d = canvas.toDataURL('image/png'); // rare fallback
      if (d.length <= CAP_CHARS && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(d))
        return { dataUri: d, kb: Math.round((d.length * 0.75) / 1024) };
    }
    throw new Error('TOO_BIG');
  } finally { URL.revokeObjectURL(url); }
}
function showPreview() {
  const thumb = $('pay-thumb'), meta = $('pay-image-meta');
  if (thumb && state.paymentImage) thumb.src = state.paymentImage;
  if (meta) meta.textContent = `${state.imageName || 'صورة'} • ~${state.imageKb} KB بعد الضغط`;
  toggle('pay-image-preview', false);
}
async function onPickImage() {
  if (!state.pending || state.reservation) return;
  const input = $('pay-image-input');
  const file = input?.files?.[0];
  if (!file) return;
  hideError();
  const att = $('pay-image-btn');
  if (att) { att.disabled = true; att.textContent = 'جارٍ معالجة الصورة…'; }
  try {
    const out = await compressImage(file);
    state.paymentImage = out.dataUri;
    state.imageName = (file.name || 'صورة').slice(0, 40);
    state.imageKb = out.kb;
    showPreview();
    applyInteractionState();
    updateFlow();
    announce('تم إرفاق الصورة. اضغط «سجّل الحجز» للحفظ.');
  } catch (e) {
    state.paymentImage = null;
    toggle('pay-image-preview', true);
    const map = { TYPE: 'الملف يجب أن يكون صورة (PNG أو JPG أو WEBP).', TOO_BIG: 'الصورة كبيرة جدًا حتى بعد الضغط. جرّب لقطة شاشة أوضح أو أصغر.', LOAD: 'تعذر قراءة الصورة. جرّب ملفًا آخر.' };
    showError(map[e.message] || 'تعذر معالجة الصورة. جرّب مرة أخرى.');
  } finally {
    if (att) { att.disabled = false; att.textContent = state.paymentImage ? 'تغيير الصورة' : 'اختيار صورة التحويل'; }
    applyInteractionState();
  }
}

/* STEP 4 — the single database write. No popup, no window.open. */
async function recordBooking() {
  if (state.reservation || state.submitting) return;
  if (!state.pending || !state.selected) return;
  if (!state.paymentImage) { showError('أرفق صورة دفع إنستاباي أولًا.'); return; }

  const pid = state.selected, qty = state.qty, sig = `${pid}:${qty}`;
  if (state.keySig !== sig) { state.key = crypto.randomUUID(); state.keySig = sig; }

  state.submitting = true; hideError();
  const sub = $('pay-submit');
  if (sub) { sub.disabled = true; sub.textContent = 'جارٍ تسجيل الحجز وحفظ الصورة…'; }

  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        performance_id: pid, quantity: qty, idempotency_key: state.key,
        customer_name: state.customerName, customer_phone: state.customerPhone,
        payment_image: state.paymentImage,
      }),
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data?.ok) {
      state.reservation = data.reservation;
      state.key = null; state.keySig = null;     // attempt finished: retire the key
      renderCommitted(state.reservation);
      loadAvailability();
      announce('تم تسجيل الحجز وحفظ صورة الدفع. سيراجعها المنظمون ويتواصلون معك.');
    } else {
      showError(data?.error?.message || 'حدث خطأ غير متوقع. حاول مرة أخرى.');
      const code = data?.error?.code;
      if (['INSUFFICIENT_CAPACITY','PERFORMANCE_DISABLED','BOOKING_CLOSED','IDEMPOTENCY_CONFLICT'].includes(code)) {
        state.key = null; state.keySig = null; await loadAvailability();
      }
      resetSubmit();   // stay put, keep the attached image, focus retry
    }
  } catch {
    showError('تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مجددًا.');
    resetSubmit();     // key kept: retry must not double-book
  } finally {
    state.submitting = false;
    applyInteractionState();
  }
}
function resetSubmit() {
  const sub = $('pay-submit'); if (!sub) return;
  sub.disabled = !state.paymentImage;
  sub.textContent = 'سجّل الحجز وأرفق صورة الدفع';
  sub.focus({ preventScroll: true });
}

/* STATE B — reference + ticket numbers + the user's own thumbnail appear only now. */
function renderCommitted(r) {
  toggle('pay-pending', true);
  toggle('pay-committed', false);
  setText('pay-ref', r.reference);

  const list = $('pay-tickets');
  if (list) {
    list.textContent = '';
    for (const t of r.ticket_numbers) { const li = document.createElement('li'); li.dir = 'ltr'; li.textContent = t; list.appendChild(li); }
  }
  const shot = $('pay-shot');
  if (shot && state.paymentImage) { shot.src = state.paymentImage; shot.hidden = false; }

  const sub = $('pay-submit'); if (sub) sub.hidden = true;
  const att = $('pay-image-btn'); if (att) att.hidden = true;
  toggle('pay-image-preview', true);

  const nb = $('new-booking'); if (nb) nb.textContent = 'بدء حجز جديد';
  $('name-input') && ($('name-input').disabled = true);
  $('phone-input') && ($('phone-input').disabled = true);

  applyInteractionState();
  render();
  goTo($('pay-committed'), null);   // scroll to confirmation; no further on-site action
}

function newBooking() {
  state.pending = false; state.reservation = null;
  state.key = null; state.keySig = null;
  state.qty = 1; state.customerPhone = ''; state.customerName = '';
  state.paymentImage = null; state.imageName = ''; state.imageKb = 0;

  toggle('payment', true);
  const ni = $('name-input'), pi = $('phone-input'), ii = $('pay-image-input');
  if (ni) { ni.disabled = false; ni.value = ''; }
  if (pi) { pi.disabled = false; pi.value = ''; }
  if (ii) ii.value = '';
  setText('qty-value', 1);
  toggle('pay-image-preview', true);

  hideError();
  loadAvailability();
  goTo($('booking'), '#name-input');
}

async function copyText(text, feedbackEl) {
  if (!feedbackEl) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    feedbackEl.textContent = 'تم النسخ ✓';
  } catch { feedbackEl.textContent = 'تعذر النسخ — انسخ يدويًا.'; }
  setTimeout(() => { feedbackEl.textContent = ''; }, 2500);
}

function initCardPosters() {
  const hide = (img) => { const wrap = img.closest('.perf-poster-wrap'); (wrap || img).hidden = true; };
  document.querySelectorAll('.perf-poster').forEach((img) => {
    img.addEventListener('error', () => hide(img));
    if (img.complete && img.naturalWidth === 0) hide(img);
  });
}
function initPoster() {
  const img = $('poster-img'); if (!img) return;
  img.addEventListener('load', () => { img.hidden = false; toggle('poster-fallback', true); });
  img.addEventListener('error', () => { /* keep the styled fallback poster */ });
  img.src = img.dataset.src;
}
function initScenes() {
  const scenes = [...document.querySelectorAll('.scene')];
  const revealTargets = scenes.filter((s) => !s.classList.contains('scene--load') && !s.classList.contains('scene--instant') && !s.hidden);
  if (!('IntersectionObserver' in window)) scenes.forEach((s) => s.classList.add('is-in'));
  else {
    const revealer = new IntersectionObserver((entries, obs) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); obs.unobserve(e.target); }
    }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });
    revealTargets.forEach((s) => revealer.observe(s));
    const tabs = new Map([...document.querySelectorAll('.spine-tab')].map((t) => [t.dataset.go, t]));
    const byId = { '01': $('scene-01'),'02': $('scene-02'),'03': $('booking'),'04': $('payment'),'05': $('scene-05'),'06': $('scene-06'), end: $('scene-end') };
    const tracker = new IntersectionObserver((entries) => {
      for (const e of entries) { const tab = tabs.get(e.target.dataset.scene); if (tab && e.isIntersecting) { tabs.forEach((t) => t.classList.remove('active')); tab.classList.add('active'); } }
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
    Object.values(byId).forEach((el) => el && tracker.observe(el));
  }
  const forceVisibleNow = () => { const vh = innerHeight; scenes.forEach((s) => { const r = s.getBoundingClientRect(); if (r.top < vh * 0.92 && r.bottom > 0) s.classList.add('is-in'); }); };
  if (document.readyState === 'complete') setTimeout(forceVisibleNow, 60);
  else addEventListener('load', () => setTimeout(forceVisibleNow, 60), { once: true });
}

function init() {
  for (const el of Object.values(perfEls)) el?.addEventListener('click', () => selectPerformance(el.dataset.perf));
  $('qty-minus')?.addEventListener('click', () => setQty(state.qty - 1));
  $('qty-plus')?.addEventListener('click', () => setQty(state.qty + 1));
  $('book-btn')?.addEventListener('click', continueToPayment);                 // STEP 2 — no write
  $('pay-image-btn')?.addEventListener('click', () => $('pay-image-input')?.click());
  $('pay-image-input')?.addEventListener('change', onPickImage);              // compress + preview, no write
  $('pay-submit')?.addEventListener('click', recordBooking);                  // STEP 4 — the only write
  $('copy-instapay')?.addEventListener('click', () => copyText(state.data?.config.instapay_address || '', $('copy-feedback')));
  $('new-booking')?.addEventListener('click', newBooking);
  $('refresh-avail')?.addEventListener('click', loadAvailability);

  $('phone-input')?.addEventListener('input', () => {
    const open = !!state.data?.booking_open && !!state.selected && !state.pending && !state.reservation && !state.submitting;
    $('book-btn')?.classList.toggle('ready', open && !!normalizePhone($('phone-input')?.value || ''));
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.reservation) loadAvailability(); });

  initCardPosters(); initPoster(); initScenes(); updateFlow(); loadAvailability();
}
init();
