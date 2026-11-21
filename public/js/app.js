// Masrah Saydala — purchase page logic (vanilla ES module, no dependencies).
// Tickets are written to the database only when the user clicks the WhatsApp handoff button.
import { formatEGP, formatTime, formatDateAr, formatExpiry, normalizePhone } from './format.js';
import { buildWhatsAppMessage, buildWhatsAppUrl } from './whatsapp.js';

document.documentElement.classList.add('js'); // gates hidden reveal start-states

const $ = (id) => document.getElementById(id);
const toggle = (id, isHidden) => { const el = $(id); if (el) el.hidden = isHidden; };
const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };

const state = {
  data: null,
  selected: null,
  qty: 1,
  reservation: null,
  customerName: '',
  customerPhone: '',
  keys: new Map(), // idempotency keys per performance:quantity attempt
  clockOffset: 0,
  timer: null,
  submitting: false,
};

const perfEls = { A: $('perf-A'), B: $('perf-B') };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const announce = (msg) => setText('status-live', msg);
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
  if (!d) {
    pill.textContent = 'جارٍ التحقق…';
    pill.className = 'head-pill idle';
    return;
  }
  if (d.config.test_mode) {
    pill.textContent = 'وضع الاختبار';
    pill.className = 'head-pill test';
  } else if (d.booking_open) {
    pill.textContent = 'الحجز مفتوح';
    pill.className = 'head-pill open';
  } else {
    pill.textContent = 'الحجز مغلق';
    pill.className = 'head-pill closed';
  }
}

function updateFlow() {
  const hasSel = !!state.selected;
  const hasRes = !!state.reservation;
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

  toggle('closed-banner', !d.booking_open);
  toggle('test-banner', !d.config.test_mode);
  updateHeadStatus();

  document.querySelectorAll('.ttl-echo').forEach((el) => {
    el.textContent = d.config.reservation_minutes;
  });

  if (d.config.whatsapp_number) {
    const a = $('contact-wa');
    if (a) {
      a.href = `https://wa.me/${d.config.whatsapp_number}`;
      a.hidden = false;
    }
    toggle('contact-missing', true);
  }

  for (const p of d.performances) {
    const el = perfEls[p.id];
    if (!el) continue;

    el.querySelector('.perf-date').textContent = formatDateAr(p.event_date);
    el.querySelector('.perf-doors').textContent = formatTime(p.doors_open);
    el.querySelector('.perf-starts').textContent = formatTime(p.starts_at);
    el.querySelector('.perf-price').textContent = p.configured
      ? `${formatEGP(p.price_piasters)} ج.م`
      : 'يُعلن لاحقًا';
    el.querySelector('.perf-available').textContent = p.configured
      ? `${p.available} تذكرة`
      : '—';

    const badge = el.querySelector('.perf-badge');
    if (p.bookable) {
      badge.textContent = 'متاح للحجز';
      badge.className = 'perf-badge ok';
    } else if (p.configured && p.available <= 0) {
      badge.textContent = 'اكتمل العدد';
      badge.className = 'perf-badge soldout';
    } else {
      badge.textContent = 'غير متاح بعد';
      badge.className = 'perf-badge off';
    }

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
  const fs = $('booking-fieldset');
  if (fs) fs.disabled = !open;

  const btn = $('wa-book-btn');
  if (btn) {
    const label = state.data?.config.whatsapp_number
      ? 'أرسل صورة دفع إنستاباي على واتساب'
      : 'احجز وعاين رسالة واتساب';
    btn.disabled = !open || state.submitting;
    btn.textContent = state.submitting ? 'جارٍ إنشاء الحجز وفتح واتساب…' : label;
  }
}

function selectPerformance(id) {
  if (state.reservation) return;
  state.selected = id;
  state.qty = 1;
  hideError();
  render();
  announce(`تم اختيار ${perfById(id).name}`);
}

function setQty(n) {
  state.qty = Math.min(Math.max(1, n), maxQty());
  setText('qty-value', state.qty);

  const minus = $('qty-minus');
  const plus = $('qty-plus');
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
  const e = $('book-error');
  if (e) {
    e.textContent = msg;
    e.hidden = false;
  }
}

function hideError() {
  toggle('book-error', true);
}

function getIdempotencyKey(sig) {
  let key = state.keys.get(sig);
  if (!key) {
    key = crypto.randomUUID();
    state.keys.set(sig, key);
  }
  return key;
}

async function reserveAndOpenWhatsApp() {
  if (!state.selected || state.submitting || state.reservation) return;

  const phoneInput = $('phone-input');
  const phone = phoneInput ? normalizePhone(phoneInput.value) : null;
  if (!phone) {
    showError('من فضلك أدخل رقم موبايل صحيح لمطابقة الدفع (مثال: 01012345678).');
    phoneInput?.focus();
    return;
  }

  const pid = state.selected;
  const qty = state.qty;
  const sig = `${pid}:${qty}`;
  const key = getIdempotencyKey(sig);

  state.customerName = ($('name-input')?.value || '').trim();
  state.customerPhone = phone;

  const hasWhatsAppNumber = !!state.data?.config.whatsapp_number;

  // Open a blank tab synchronously during the click gesture to avoid popup blocking.
  // If the reservation succeeds, we navigate it to WhatsApp. If it fails, we close it.
  let waWindow = null;
  if (hasWhatsAppNumber) {
    try {
      waWindow = window.open('', '_blank');
    } catch {
      waWindow = null;
    }
  }

  state.submitting = true;
  hideError();
  applyInteractionState();

  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        performance_id: pid,
        quantity: qty,
        idempotency_key: key,
        customer_name: state.customerName,
        customer_phone: phone,
      }),
    });

    const data = await res.json().catch(() => null);

    if (res.ok && data?.ok) {
      state.reservation = data.reservation;
      renderPayment();

      const p = perfById(state.reservation.performance_id);
      const msg = buildWhatsAppMessage({
        event: state.data.event,
        performance: p,
        reservation: state.reservation,
        customerName: state.customerName,
        customerPhone: state.customerPhone,
      });

      if (hasWhatsAppNumber) {
        const url = buildWhatsAppUrl(state.data.config.whatsapp_number, msg);

        if (waWindow && !waWindow.closed) {
          try {
            waWindow.opener = null;
            waWindow.location.href = url;
            announce('تم إنشاء حجز مؤقت وفتح واتساب.');
          } catch {
            showError('تم الحجز، لكن المتصفح منع فتح واتساب تلقائيًا. اضغط زر واتساب في قسم الدفع.');
            announce('تم إنشاء حجز مؤقت. افتح واتساب من الزر الظاهر في قسم الدفع.');
          }
        } else {
          showError('تم الحجز، لكن المتصفح منع فتح واتساب تلقائيًا. اضغط زر واتساب في قسم الدفع.');
          announce('تم إنشاء حجز مؤقت. افتح واتساب من الزر الظاهر في قسم الدفع.');
        }
      } else {
        announce('تم إنشاء حجز مؤقت. راجع رسالة واتساب في قسم الدفع.');
      }

      loadAvailability();
    } else {
      if (waWindow && !waWindow.closed) waWindow.close();

      showError(data?.error?.message || 'حدث خطأ غير متوقع. حاول مرة أخرى.');
      const code = data?.error?.code;
      if (['INSUFFICIENT_CAPACITY', 'PERFORMANCE_DISABLED', 'BOOKING_CLOSED'].includes(code)) {
        await loadAvailability();
      }
    }
  } catch {
    if (waWindow && !waWindow.closed) waWindow.close();
    showError('تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مجددًا.');
  } finally {
    state.submitting = false;
    applyInteractionState();
  }
}

function renderPayment() {
  const r = state.reservation;
  const cfg = state.data.config;
  const p = perfById(r.performance_id);

  const pay = $('payment');
  if (pay) {
    pay.hidden = false;
    // Replay the receipt-print animation on repeat bookings.
    pay.style.animation = 'none';
    void pay.offsetWidth;
    pay.style.animation = '';
  }

  setText('pay-ref', r.reference);
  setText('pay-amount', formatEGP(r.total_piasters));
  setText('pay-expiry', formatExpiry(r.expires_at));
  toggle('pay-test', !cfg.test_mode);

  const noPaymentDetails = cfg.test_mode && !cfg.instapay_address;
  toggle('instapay-block', noPaymentDetails);
  if (!noPaymentDetails) setText('pay-instapay', cfg.instapay_address);

  const list = $('pay-tickets');
  if (list) {
    list.textContent = '';
    for (const t of r.ticket_numbers) {
      const li = document.createElement('li');
      li.dir = 'ltr';
      li.textContent = t;
      list.appendChild(li);
    }
  }

  const msg = buildWhatsAppMessage({
    event: state.data.event,
    performance: p,
    reservation: r,
    customerName: state.customerName,
    customerPhone: state.customerPhone,
  });

  const wa = $('wa-link');
  if (cfg.whatsapp_number) {
    if (wa) {
      wa.href = buildWhatsAppUrl(cfg.whatsapp_number, msg);
      wa.hidden = false;
      wa.classList.remove('disabled');
      wa.removeAttribute('aria-disabled');
    }
    toggle('wa-fallback', true);
  } else {
    if (wa) wa.hidden = true;
    toggle('wa-fallback', false);
    const prev = $('wa-preview');
    if (prev) prev.value = msg;
  }

  toggle('pay-expired', true);

  const ni = $('name-input');
  const pi = $('phone-input');
  if (ni) ni.disabled = true;
  if (pi) pi.disabled = true;

  applyInteractionState();
  render();
  startCountdown();

  if (pay) pay.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
}

function startCountdown() {
  clearInterval(state.timer);
  const tick = () => {
    if (!state.reservation) return;
    const remaining = Math.round(state.reservation.expires_at - (Date.now() / 1000 + state.clockOffset));
    const el = $('pay-countdown');
    if (remaining <= 0) {
      expireReservation();
      return;
    }
    if (el) {
      el.textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
      el.classList.toggle('urgent', remaining <= 120);
    }
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

function expireReservation() {
  clearInterval(state.timer);
  setText('pay-countdown', '00:00');
  toggle('pay-expired', false);

  const wa = $('wa-link');
  if (wa) {
    wa.removeAttribute('href');
    wa.classList.add('disabled');
    wa.setAttribute('aria-disabled', 'true');
  }
  toggle('wa-fallback', true);

  announce('انتهت مهلة الحجز المؤقت. ابدأ حجزًا جديدًا.');
  loadAvailability();
}

function newBooking() {
  clearInterval(state.timer);
  state.reservation = null;
  state.keys = new Map();
  state.qty = 1;
  state.customerPhone = '';

  toggle('payment', true);

  const ni = $('name-input');
  const pi = $('phone-input');
  if (ni) ni.disabled = false;
  if (pi) pi.disabled = false;

  hideError();
  loadAvailability();
  $('booking')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
}

async function copyText(text, feedbackEl) {
  if (!feedbackEl) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    feedbackEl.textContent = 'تم النسخ ✓';
  } catch {
    feedbackEl.textContent = 'تعذر النسخ — انسخ يدويًا.';
  }
  setTimeout(() => { feedbackEl.textContent = ''; }, 2500);
}

function initCardPosters() {
  const hide = (img) => {
    const wrap = img.closest('.perf-poster-wrap');
    (wrap || img).hidden = true;
  };
  document.querySelectorAll('.perf-poster').forEach((img) => {
    img.addEventListener('error', () => hide(img));
    if (img.complete && img.naturalWidth === 0) hide(img);
  });
}

function initPoster() {
  const img = $('poster-img');
  if (!img) return;
  img.addEventListener('load', () => {
    img.hidden = false;
    toggle('poster-fallback', true);
  });
  img.addEventListener('error', () => {
    /* keep the styled fallback poster */
  });
  img.src = img.dataset.src;
}

function initScenes() {
  const scenes = [...document.querySelectorAll('.scene')];
  const revealTargets = scenes.filter((s) =>
    !s.classList.contains('scene--load') &&
    !s.classList.contains('scene--instant') &&
    !s.hidden
  );

  if (!('IntersectionObserver' in window)) {
    scenes.forEach((s) => s.classList.add('is-in'));
  } else {
    const revealer = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          obs.unobserve(e.target);
        }
      }
    }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });

    revealTargets.forEach((s) => revealer.observe(s));

    const tabs = new Map([...document.querySelectorAll('.spine-tab')].map((t) => [t.dataset.go, t]));
    const byId = {
      '01': $('scene-01'),
      '02': $('scene-02'),
      '03': $('booking'),
      '04': $('payment'),
      '05': $('scene-05'),
      '06': $('scene-06'),
      end: $('scene-end'),
    };

    const tracker = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const key = e.target.dataset.scene;
        const tab = tabs.get(key);
        if (!tab) continue;
        if (e.isIntersecting) {
          tabs.forEach((t) => t.classList.remove('active'));
          tab.classList.add('active');
        }
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
  for (const el of Object.values(perfEls)) {
    el?.addEventListener('click', () => selectPerformance(el.dataset.perf));
  }

  $('qty-minus')?.addEventListener('click', () => setQty(state.qty - 1));
  $('qty-plus')?.addEventListener('click', () => setQty(state.qty + 1));
  $('wa-book-btn')?.addEventListener('click', reserveAndOpenWhatsApp);
  $('copy-instapay')?.addEventListener('click', () => copyText(state.data?.config.instapay_address || '', $('copy-feedback')));
  $('copy-message')?.addEventListener('click', () => copyText($('wa-preview')?.value || '', $('msg-feedback')));
  $('new-booking')?.addEventListener('click', newBooking);
  $('refresh-avail')?.addEventListener('click', loadAvailability);

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
