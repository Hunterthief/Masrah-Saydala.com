// Masrah Saydala — purchase page logic (vanilla ES module, no dependencies).
import { formatEGP, formatTime, formatDateAr, formatExpiry, normalizePhone } from './format.js';
import { buildWhatsAppMessage, buildWhatsAppUrl } from './whatsapp.js';

const $ = (id) => document.getElementById(id);
const state = {
  data: null, selected: null, qty: 1, reservation: null, customerName: '', customerPhone: '',
  key: null, keySig: null, clockOffset: 0, timer: null, submitting: false,
};
const perfEls = { A: $('perf-A'), B: $('perf-B') };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const announce = (msg) => { $('status-live').textContent = msg; };
const perfById = (id) => state.data?.performances.find((p) => p.id === id);

function maxQty() {
  const p = perfById(state.selected);
  if (!p) return 1;
  return Math.max(1, Math.min(p.available, state.data.config.max_per_booking));
}

async function loadAvailability() {
  try {
    const res = await fetch('/api/availability', { headers: { accept: 'application/json' } });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error?.code || 'BAD_RESPONSE');
    state.clockOffset = (Date.parse(data.server_time) - Date.now()) / 1000;
    state.data = data;
    $('load-status').hidden = true;
    render();
  } catch {
    $('load-status').hidden = false;
    $('load-status').textContent = 'تعذر تحميل حالة التذاكر. اضغط «تحديث المتاح» للمحاولة مجددًا.';
  }
}

function updateHeadStatus() {
  const d = state.data, pill = $('head-status');
  if (!d) { pill.textContent = 'جارٍ التحقق…'; pill.className = 'head-pill idle'; return; }
  if (d.config.test_mode) { pill.textContent = 'وضع الاختبار'; pill.className = 'head-pill test'; }
  else if (d.booking_open) { pill.textContent = 'الحجز مفتوح'; pill.className = 'head-pill open'; }
  else { pill.textContent = 'الحجز مغلق'; pill.className = 'head-pill closed'; }
}

function updateFlow() {
  const hasSel = !!state.selected, hasRes = !!state.reservation;
  document.querySelectorAll('#flow li').forEach((li, i) => {
    const n = i + 1;
    let cls = '';
    if (n === 1) cls = hasSel ? 'done' : 'active';
    else if (n === 2) cls = hasRes ? 'done' : (hasSel ? 'active' : '');
    else cls = hasRes ? 'active' : '';
    li.className = cls;
  });
}

function render() {
  const d = state.data;
  if (!d) return;
  $('closed-banner').hidden = d.booking_open;
  $('test-banner').hidden = !d.config.test_mode;
  updateHeadStatus();
  document.querySelectorAll('.ttl-echo').forEach((el) => { el.textContent = d.config.reservation_minutes; });
  if (d.config.whatsapp_number) {
    const a = $('contact-wa');
    a.href = `https://wa.me/${d.config.whatsapp_number}`;
    a.hidden = false; $('contact-missing').hidden = true;
  }
  for (const p of d.performances) {
    const el = perfEls[p.id];
    if (!el) continue;
    el.querySelector('.perf-date').textContent = formatDateAr(p.event_date);
    el.querySelector('.perf-doors').textContent = formatTime(p.doors_open);
    el.querySelector('.perf-starts').textContent = formatTime(p.starts_at);
    el.querySelector('.perf-price').textContent = p.configured ? `${formatEGP(p.price_piasters)} ج.م` : 'يُعلن لاحقًا';
    el.querySelector('.perf-available').textContent = p.configured ? `${p.available} تذكرة` : '—';
    const badge = el.querySelector('.perf-badge');
    if (p.bookable) { badge.textContent = 'متاح للحجز'; badge.className = 'perf-badge ok'; }
    else if (p.configured && p.available <= 0) { badge.textContent = 'اكتمل العدد'; badge.className = 'perf-badge soldout'; }
    else { badge.textContent = 'غير متاح بعد'; badge.className = 'perf-badge off'; }
    el.disabled = !p.bookable || !!state.reservation;
    el.setAttribute('aria-pressed', String(state.selected === p.id));
    el.classList.toggle('selected', state.selected === p.id);
  }
  if (state.selected && !perfById(state.selected)?.bookable) state.selected = null;
  if (state.selected) setQty(Math.min(state.qty, maxQty()));
  applyInteractionState();
  renderSummary();
  updateFlow();
}

function applyInteractionState() {
  const open = !!state.data?.booking_open && !!state.selected && !state.reservation;
  $('booking-fieldset').disabled = !open;
  $('book-btn').disabled = !open || state.submitting;
}

function selectPerformance(id) {
  if (state.reservation) return;
  state.selected = id; state.qty = 1;
  hideError(); render();
  announce(`تم اختيار ${perfById(id).name}`);
}

function setQty(n) {
  state.qty = Math.min(Math.max(1, n), maxQty());
  $('qty-value').textContent = state.qty;
  $('qty-minus').disabled = state.qty <= 1;
  $('qty-plus').disabled = state.qty >= maxQty();
  renderSummary();
}

function renderSummary() {
  const p = perfById(state.selected);
  if (!p) {
    for (const id of ['sum-perf', 'sum-qty', 'sum-unit', 'sum-total']) $(id).textContent = '—';
    $('qty-hint').textContent = '';
    return;
  }
  $('sum-perf').textContent = `${p.name} (${p.id}) — ${formatTime(p.starts_at)}`;
  $('sum-qty').textContent = state.qty;
  $('sum-unit').textContent = `${formatEGP(p.price_piasters)} ج.م`;
  $('sum-total').textContent = `${formatEGP(p.price_piasters * state.qty)} ج.م`;
  $('qty-hint').textContent = `الحد الأقصى لكل حجز: ${state.data.config.max_per_booking} — المتاح لهذا العرض: ${p.available}`;
}

function showError(msg) { const e = $('book-error'); e.textContent = msg; e.hidden = false; }
function hideError() { $('book-error').hidden = true; }

async function submitBooking() {
  if (!state.selected || state.submitting || state.reservation) return;
  const phone = normalizePhone($('phone-input').value);
  if (!phone) {
    showError('من فضلك أدخل رقم موبايل صحيح لمطابقة الدفع (مثال: 01012345678).');
    $('phone-input').focus();
    return;
  }
  const pid = state.selected, qty = state.qty;
  const sig = `${pid}:${qty}`;
  if (state.keySig !== sig) { state.key = crypto.randomUUID(); state.keySig = sig; }
  state.customerName = $('name-input').value.trim();
  state.customerPhone = phone;
  state.submitting = true;
  hideError();
  $('book-btn').disabled = true;
  $('book-btn').textContent = 'جارٍ الحجز…';
  try {
    const res = await fetch('/api/reservations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        performance_id: pid, quantity: qty, idempotency_key: state.key,
        customer_name: state.customerName, customer_phone: phone,
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok) {
      state.reservation = data.reservation;
      renderPayment();
      announce('تم إنشاء حجزك المؤقت.');
      loadAvailability();
    } else {
      showError(data?.error?.message || 'حدث خطأ غير متوقع. حاول مرة أخرى.');
      const code = data?.error?.code;
      if (['INSUFFICIENT_CAPACITY', 'PERFORMANCE_DISABLED', 'BOOKING_CLOSED'].includes(code)) await loadAvailability();
    }
  } catch {
    showError('تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مجددًا.');
  } finally {
    state.submitting = false;
    $('book-btn').textContent = 'احجز مؤقتًا وأكمل الدفع';
    applyInteractionState();
  }
}

function renderPayment() {
  const r = state.reservation;
  const cfg = state.data.config;
  const p = perfById(r.performance_id);
  $('payment').hidden = false;
  $('pay-ref').textContent = r.reference;
  $('pay-amount').textContent = formatEGP(r.total_piasters);
  $('pay-expiry').textContent = formatExpiry(r.expires_at);
  $('pay-test').hidden = !cfg.test_mode;
  const noPaymentDetails = cfg.test_mode && !cfg.instapay_address;
  $('instapay-block').hidden = noPaymentDetails;
  if (!noPaymentDetails) $('pay-instapay').textContent = cfg.instapay_address;

  const list = $('pay-tickets');
  list.textContent = '';
  for (const t of r.ticket_numbers) {
    const li = document.createElement('li');
    li.dir = 'ltr'; li.textContent = t;
    list.appendChild(li);
  }

  const msg = buildWhatsAppMessage({
    event: state.data.event, performance: p, reservation: r,
    customerName: state.customerName, customerPhone: state.customerPhone,
  });
  const wa = $('wa-link');
  if (cfg.whatsapp_number) {
    wa.href = buildWhatsAppUrl(cfg.whatsapp_number, msg);
    wa.hidden = false;
    wa.classList.remove('disabled');
    wa.removeAttribute('aria-disabled');
    $('wa-fallback').hidden = true;
  } else {
    wa.hidden = true;
    $('wa-fallback').hidden = false;
    $('wa-preview').value = msg;
  }
  $('pay-expired').hidden = true;
  $('name-input').disabled = true;
  $('phone-input').disabled = true;
  applyInteractionState(); render(); startCountdown();
  $('payment').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
}

function startCountdown() {
  clearInterval(state.timer);
  const tick = () => {
    const remaining = Math.round(state.reservation.expires_at - (Date.now() / 1000 + state.clockOffset));
    const el = $('pay-countdown');
    if (remaining <= 0) { expireReservation(); return; }
    el.textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    el.classList.toggle('urgent', remaining <= 120);
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

function expireReservation() {
  clearInterval(state.timer);
  $('pay-countdown').textContent = '00:00';
  $('pay-expired').hidden = false;
  const wa = $('wa-link');
  wa.removeAttribute('href');
  wa.classList.add('disabled');
  wa.setAttribute('aria-disabled', 'true');
  $('wa-fallback').hidden = true;
  announce('انتهت مهلة الحجز المؤقت. ابدأ حجزًا جديدًا.');
  loadAvailability();
}

function newBooking() {
  clearInterval(state.timer);
  state.reservation = null; state.key = null; state.keySig = null; state.qty = 1;
  $('payment').hidden = true;
  $('name-input').disabled = false;
  $('phone-input').disabled = false;
  hideError(); loadAvailability();
  $('booking').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
}

async function copyText(text, feedbackEl) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); }
    else {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
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
  const img = $('poster-img');
  img.addEventListener('load', () => { img.hidden = false; $('poster-fallback').hidden = true; });
  img.addEventListener('error', () => { /* keep the styled fallback poster */ });
  img.src = img.dataset.src;
}

function init() {
  for (const el of Object.values(perfEls)) el.addEventListener('click', () => selectPerformance(el.dataset.perf));
  $('qty-minus').addEventListener('click', () => setQty(state.qty - 1));
  $('qty-plus').addEventListener('click', () => setQty(state.qty + 1));
  $('book-btn').addEventListener('click', submitBooking);
  $('copy-instapay').addEventListener('click', () => copyText(state.data?.config.instapay_address || '', $('copy-feedback')));
  $('copy-message').addEventListener('click', () => copyText($('wa-preview').value, $('msg-feedback')));
  $('new-booking').addEventListener('click', newBooking);
  $('refresh-avail').addEventListener('click', loadAvailability);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.reservation) loadAvailability(); });
  initCardPosters();
  initPoster();
  updateFlow();
  loadAvailability();
}

init();
