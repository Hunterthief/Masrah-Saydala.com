// Masrah Saydala — purchase page logic (vanilla ES module, no dependencies).
//
// Flow contract:
//   Step 1  choose show / qty / name / phone        -> no network, no DB
//   Step 2  "متابعة إلى الدفع" (continueToPayment)  -> renders payment panel, STILL no DB
//   Step 3  "سجّل الحجز وأرسل..." (#wa-send)        -> the ONLY POST /api/reservations
//
// Auto-progression: finishing a step carries the user to the next one (scroll + focus +
// a "ready" pulse on the control). The WhatsApp press is NEVER auto-fired: it is the only
// DB write and the only popup gesture, so it must stay a real user click.
// After choosing a show the cursor lands on the NAME field first, then the number.
// No countdown / no expiry figure anywhere (hold is server-side only).

import { formatEGP, formatTime, formatDateAr, normalizePhone } from './format.js';
import { buildWhatsAppMessage, buildWhatsAppUrl } from './whatsapp.js';

document.documentElement.classList.add('js');

const $ = (id) => document.getElementById(id);
const toggle = (id, isHidden) => { const el = $(id); if (el) el.hidden = isHidden; };
const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };

// Set to false to keep the auto-scroll but stop stealing focus (e.g. if the mobile
// keyboard popping up on show-select feels intrusive).
const AUTO_FOCUS = true;

const state = {
  data: null,
  selected: null,
  qty: 1,
  pending: false,        // payment panel open, NOT yet committed
  reservation: null,     // committed: has reference + ticket numbers
  customerName: '',
  customerPhone: '',
  key: null,             // idempotency key for the single commit attempt
  keySig: null,
  clockOffset: 0,
  submitting: false,
};

const perfEls = { A: $('perf-A'), B: $('perf-B') };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const announce = (msg) => setText('status-live', msg);
const perfById = (id) => state.data?.performances.find((p) => p.id === id);

/* ---------- auto-progression helper ---------- */
// Smooth-scrolls an element into view, then (optionally) focuses a control inside it.
// focus({preventScroll:true}) so the focus doesn't fight the smooth scroll.
function goTo(el, focusSel) {
  if (!el) return;
  el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  if (AUTO_FOCUS && focusSel) {
    const f = $(focusSel) || document.querySelector(focusSel);
    f?.focus({ preventScroll: true });
  }
}

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
    toggle('load-status', true);
    render();
  } catch {
    const el = $('load-status');
    if (el) {
      el.hidden = false;
      el.textContent = 'تعذر تحميل حالة التذاكر. اضغط «تحديث المتاح» للمحاولة مجددًا.';
    }
  }
}

function updateHeadStatus() {
  const d = state.data;
  const pill = $('head-status');
  if (!pill) return;
  if (!d) { pill.textContent = 'جارٍ التحقق…'; pill.className = 'head-pill idle'; return; }
  if (d.config.test_mode) { pill.textContent = 'وضع الاختبار'; pill.className = 'head-pill test'; }
  else if (d.booking_open) { pill.textContent = 'الحجز مفتوح'; pill.className = 'head-pill open'; }
  else { pill.textContent = 'الحجز مغلق'; pill.className = 'head-pill closed'; }
}

function updateFlow() {
  const hasSel = !!state.selected;
  const pending = !!state.pending;
  const done = !!state.reservation;
  document.querySelectorAll('#flow li').forEach((li, i) => {
    const n = i + 1;
    let cls = '';
    if (n === 1) cls = hasSel ? 'done' : 'active';
    else if (n === 2) cls = (pending || done) ? 'done' : (hasSel ? 'active' : '');
    else if (n === 3) cls = done ? 'done' : (pending ? 'active' : '');
    else cls = done ? 'active' : '';
    li.className = cls;
  });
}

function render() {
  const d = state.data;
  if (!d) return;

  toggle('closed-banner', !d.booking_open);
  toggle('test-banner', !d.config.test_mode);
  updateHeadStatus();

  if (d.config.whatsapp_number) {
    const a = $('contact-wa');
    if (a) { a.href = `https://wa.me/${d.config.whatsapp_number}`; a.hidden = false; }
    toggle('contact-missing', true);
  }

  for (const p of d.performances) {
    const el = perfEls[p.id];
    if (!el) continue;

    el.querySelector('.perf-date').textContent = formatDateAr(p.event_date);
    el.querySelector('.perf-doors').textContent = formatTime(p.doors_open);
    el.querySelector('.perf-starts').textContent = formatTime(p.starts_at);
    el.querySelector('.perf-price').textContent = p.configured
      ? `${formatEGP(p.price_piasters)} ج.م` : 'يُعلن لاحقًا';
    el.querySelector('.perf-available').textContent = p.configured
      ? `${p.available} تذكرة` : '—';

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
  const fs = $('booking-fieldset');
  if (fs) fs.disabled = !open;

  const btn = $('book-btn');
  if (btn) {
    btn.disabled = !open || state.submitting;
    btn.textContent = state.submitting ? 'جارٍ إنشاء الحجز…' : 'متابعة إلى الدفع';
    // "ready" pulse only when the step is genuinely completable (valid phone typed)
    const phoneOk = !!normalizePhone($('phone-input')?.value || '');
    btn.classList.toggle('ready', open && phoneOk && !state.submitting);
  }

  const send = $('wa-send');
  if (send) {
    const locked = !!state.reservation;
    send.disabled = locked || state.submitting || !state.pending;
    if (locked) send.hidden = true;
  }
}

function selectPerformance(id) {
  if (state.pending || state.reservation) return;
  state.selected = id;
  state.qty = 1;
  hideError();
  render();
  announce(`تم اختيار ${perfById(id).name}`);
  // AUTO-PROGRESS step 1 -> 2: carry the user to the details form, cursor on the NAME field
  goTo($('booking-fieldset'), '#name-input');
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
  if (!p) {
    for (const id of ['sum-perf', 'sum-qty', 'sum-unit', 'sum-total']) setText(id, '—');
    setText('qty-hint', '');
    return;
  }
  setText('sum-perf', `${p.name} (${p.id}) — ${formatTime(p.starts_at)}`);
  setText('sum-qty', state.qty);
  setText('sum-unit', `${formatEGP(p.price_piasters)} ج.م`);
  setText('sum-total', `${formatEGP(p.price_piasters * state.qty)} ج.م`);
  setText('qty-hint', `الحد الأقصى لكل حجز: ${state.data.config.max_per_booking} — المتاح لهذا العرض: ${p.available}`);
}

function showError(msg) {
  const inPanel = !$('payment')?.hidden;
  const active = $(inPanel ? 'pay-error' : 'book-error');
  const other = $(inPanel ? 'book-error' : 'pay-error');
  if (other) other.hidden = true;
  if (active) { active.textContent = msg; active.hidden = false; }
}
function hideError() { toggle('book-error', true); toggle('pay-error', true); }

/* STEP 2 — continue to payment. Validation + panel only. ZERO writes. */
function continueToPayment() {
  if (state.pending || state.reservation) return;
  if (!state.selected) { showError('اختر العرض أولًا.'); return; }

  const phoneInput = $('phone-input');
  const phone = phoneInput ? normalizePhone(phoneInput.value) : null;
  if (!phone) {
    showError('من فضلك أدخل رقم موبايل صحيح لمطابقة الدفع (مثال: 01012345678).');
    phoneInput?.focus();
    return;
  }

  state.customerPhone = phone;
  state.customerName = ($('name-input')?.value || '').trim();
  state.pending = true;
  hideError();
  renderPendingPanel();
  render();
  announce('راجع المبلغ وتعليمات التحويل. لا يُسجَّـل الحجز إلا عند ضغط زر واتساب.');
  // AUTO-PROGRESS step 2 -> 3: panel is open, focus the WhatsApp button
  goTo($('payment'), '#wa-send');
}

/** STATE A of the payment panel — no reference, no ticket numbers. */
function renderPendingPanel() {
  const p = perfById(state.selected);
  const cfg = state.data.config;
  if (!p) return;

  const pay = $('payment');
  if (pay) {
    pay.hidden = false;
    pay.style.animation = 'none'; void pay.offsetWidth; pay.style.animation = '';
  }

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

  const send = $('wa-send');
  if (send) {
    send.hidden = false;
    send.disabled = false;
    send.textContent = cfg.whatsapp_number
      ? 'سجّل الحجز وأرسل صورة الدفع على واتساب'
      : 'سجّل الحجز وعاين رسالة واتساب';
  }
  toggle('wa-open', true);
  toggle('wa-fallback', true);

  const nb = $('new-booking');
  if (nb) nb.textContent = 'تعديل الحجز';
}

/* STEP 3 — the single database write. Opens the tab synchronously
   (still inside the click gesture), then navigates it after the POST. */
async function commitAndOpenWhatsApp() {
  if (state.reservation || state.submitting) return;
  if (!state.pending || !state.selected) return;

  const cfg = state.data.config;
  const hasWa = !!cfg.whatsapp_number;

  let tab = null;
  if (hasWa) { try { tab = window.open('', '_blank'); } catch { tab = null; } }

  const pid = state.selected;
  const qty = state.qty;
  const sig = `${pid}:${qty}`;
  if (state.keySig !== sig) { state.key = crypto.randomUUID(); state.keySig = sig; }

  state.submitting = true;
  hideError();
  const send = $('wa-send');
  if (send) { send.disabled = true; send.textContent = 'جارٍ تسجيل الحجز…'; }

  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        performance_id: pid,
        quantity: qty,
        idempotency_key: state.key,
        customer_name: state.customerName,
        customer_phone: state.customerPhone,
      }),
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data?.ok) {
      state.reservation = data.reservation;
      state.key = null; state.keySig = null;   // attempt finished: retire the key

      const p = perfById(state.reservation.performance_id);
      const msg = buildWhatsAppMessage({
        event: state.data.event,
        performance: p,
        reservation: state.reservation,
        customerName: state.customerName,
        customerPhone: state.customerPhone,
      });
      const url = hasWa ? buildWhatsAppUrl(cfg.whatsapp_number, msg) : null;

      renderCommitted(state.reservation, url);
      loadAvailability();

      if (hasWa) {
        if (tab && !tab.closed) {
          try { tab.opener = null; tab.location.href = url; announce('تم تسجيل الحجز وفتح واتساب.'); }
          catch { announce('تم تسجيل الحجز. اضغط «افتح واتساب».'); }
        } else {
          showError('تم تسجيل حجزك، لكن المتصفح منع الفتح التلقائي. اضغط «افتح واتساب» أدناه.');
          announce('تم تسجيل الحجز. افتح واتساب من الزر الظاهر.');
        }
      } else {
        announce('تم تسجيل الحجز. راجع نص رسالة واتساب في الأسفل.');
      }
    } else {
      if (tab && !tab.closed) tab.close();
      showError(data?.error?.message || 'حدث خطأ غير متوقع. حاول مرة أخرى.');
      const code = data?.error?.code;
      if (['INSUFFICIENT_CAPACITY', 'PERFORMANCE_DISABLED', 'BOOKING_CLOSED', 'IDEMPOTENCY_CONFLICT'].includes(code)) {
        state.key = null; state.keySig = null;
        await loadAvailability();
      }
      resetSendButton();   // stay put, keep focus on the retry control
    }
  } catch {
    if (tab && !tab.closed) tab.close();
    showError('تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مجددًا.');
    resetSendButton();     // key deliberately kept: retry must not double-book
  } finally {
    state.submitting = false;
    applyInteractionState();
  }
}

function resetSendButton() {
  const send = $('wa-send');
  const cfg = state.data?.config;
  if (!send) return;
  send.disabled = false;
  send.textContent = cfg?.whatsapp_number
    ? 'سجّل الحجز وأرسل صورة الدفع على واتساب'
    : 'سجّل الحجز وعاين رسالة واتساب';
  send.focus({ preventScroll: true });
}

/** STATE B — reference + ticket numbers appear only now. */
function renderCommitted(r, url) {
  toggle('pay-pending', true);
  toggle('pay-committed', false);
  setText('pay-ref', r.reference);

  const list = $('pay-tickets');
  if (list) {
    list.textContent = '';
    for (const t of r.ticket_numbers) {
      const li = document.createElement('li');
      li.dir = 'ltr'; li.textContent = t;
      list.appendChild(li);
    }
  }

  const send = $('wa-send');
  if (send) send.hidden = true;

  const open = $('wa-open');
  if (url) {
    if (open) { open.href = url; open.hidden = false; }
    toggle('wa-fallback', true);
  } else {
    if (open) open.hidden = true;
    toggle('wa-fallback', false);
    const prev = $('wa-preview');
    if (prev) {
      const p = perfById(r.performance_id);
      prev.value = buildWhatsAppMessage({
        event: state.data.event, performance: p, reservation: r,
        customerName: state.customerName, customerPhone: state.customerPhone,
      });
    }
  }

  const nb = $('new-booking');
  if (nb) nb.textContent = 'بدء حجز جديد';

  $('name-input') && ($('name-input').disabled = true);
  $('phone-input') && ($('phone-input').disabled = true);

  applyInteractionState();
  render();

  // AUTO-PROGRESS step 3 -> 4: land the user on the confirmed block + the send/open control
  goTo($('pay-committed'), url ? '#wa-open' : '#new-booking');
}

function newBooking() {
  state.pending = false;
  state.reservation = null;
  state.key = null;
  state.keySig = null;
  state.qty = 1;
  state.customerPhone = '';
  state.customerName = '';

  toggle('payment', true);

  const ni = $('name-input'), pi = $('phone-input');
  if (ni) { ni.disabled = false; ni.value = ''; }
  if (pi) { pi.disabled = false; pi.value = ''; }
  setText('qty-value', 1);

  hideError();
  loadAvailability();
  goTo($('booking'), '#name-input');   // back to step 1 input, name first
}

async function copyText(text, feedbackEl) {
  if (!feedbackEl) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
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
  if (!img) return;
  img.addEventListener('load', () => { img.hidden = false; toggle('poster-fallback', true); });
  img.addEventListener('error', () => { /* keep the styled fallback poster */ });
  img.src = img.dataset.src;
}

function initScenes() {
  const scenes = [...document.querySelectorAll('.scene')];
  const revealTargets = scenes.filter((s) =>
    !s.classList.contains('scene--load') && !s.classList.contains('scene--instant') && !s.hidden);

  if (!('IntersectionObserver' in window)) {
    scenes.forEach((s) => s.classList.add('is-in'));
  } else {
    const revealer = new IntersectionObserver((entries, obs) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); obs.unobserve(e.target); }
    }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });
    revealTargets.forEach((s) => revealer.observe(s));

    const tabs = new Map([...document.querySelectorAll('.spine-tab')].map((t) => [t.dataset.go, t]));
    const byId = {
      '01': $('scene-01'), '02': $('scene-02'), '03': $('booking'), '04': $('payment'),
      '05': $('scene-05'), '06': $('scene-06'), end: $('scene-end'),
    };
    const tracker = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const tab = tabs.get(e.target.dataset.scene);
        if (tab && e.isIntersecting) { tabs.forEach((t) => t.classList.remove('active')); tab.classList.add('active'); }
      }
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
    Object.values(byId).forEach((el) => el && tracker.observe(el));
  }

  const forceVisibleNow = () => {
    const vh = innerHeight;
    scenes.forEach((s) => {
      const rect = s.getBoundingClientRect();
      if (rect.top < vh * 0.92 && rect.bottom > 0) s.classList.add('is-in');
    });
  };
  if (document.readyState === 'complete') setTimeout(forceVisibleNow, 60);
  else addEventListener('load', () => setTimeout(forceVisibleNow, 60), { once: true });
}

function init() {
  for (const el of Object.values(perfEls)) el?.addEventListener('click', () => selectPerformance(el.dataset.perf));

  $('qty-minus')?.addEventListener('click', () => setQty(state.qty - 1));
  $('qty-plus')?.addEventListener('click', () => setQty(state.qty + 1));
  $('book-btn')?.addEventListener('click', continueToPayment);      // STEP 2 — no write
  $('wa-send')?.addEventListener('click', commitAndOpenWhatsApp);   // STEP 3 — the only write
  $('copy-instapay')?.addEventListener('click', () => copyText(state.data?.config.instapay_address || '', $('copy-feedback')));
  $('copy-message')?.addEventListener('click', () => copyText($('wa-preview')?.value || '', $('msg-feedback')));
  $('new-booking')?.addEventListener('click', newBooking);
  $('refresh-avail')?.addEventListener('click', loadAvailability);

  // live "ready" pulse on the continue button as the phone is typed (no full render per keystroke)
  $('phone-input')?.addEventListener('input', () => {
    const open = !!state.data?.booking_open && !!state.selected && !state.pending && !state.reservation && !state.submitting;
    const ok = !!normalizePhone($('phone-input')?.value || '');
    $('book-btn')?.classList.toggle('ready', open && ok);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.reservation) loadAvailability();
  });

  initCardPosters();
  initPoster();
  initScenes();
  updateFlow();
  loadAvailability();
}

init();
