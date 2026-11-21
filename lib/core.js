// Shared backend core: Cloudflare Pages Functions + Node test suite. Pure ESM, parameterized SQL.
export const EVENT = {
  name: 'مكتب حل المشاكل التافهة',
  organizer: 'فريق مسرح صيدلة إسكندرية — كلية الصيدلة، جامعة الإسكندرية',
  date: '2026-12-03', timezone: 'Africa/Cairo',
  venue: 'كلية الصيدلة — المبنى الجديد — الدور الثالث',
};

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1 ambiguity

function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function readConfig(env) {
  const instapay = String(env.INSTAPAY_ADDRESS ?? '').trim();
  const whatsapp = String(env.WHATSAPP_NUMBER ?? '').replace(/\D/g, '');
  const whatsappValid = /^\d{8,15}$/.test(whatsapp);
  const flagOn = String(env.BOOKING_ENABLED ?? 'true').toLowerCase() !== 'false';
  return {
    ttlMinutes: clampInt(env.RESERVATION_TTL_MINUTES, 1, 120, 15),
    maxPerBooking: clampInt(env.MAX_TICKETS_PER_BOOKING, 1, 50, 10),
    instapay, whatsapp: whatsappValid ? whatsapp : '',
    // Booking can never open until the payment + contact placeholders are filled.
    bookingOpen: flagOn && instapay.length > 0 && whatsappValid,
  };
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
export const err = (status, code, message) => json({ ok: false, error: { code, message } }, status);

export const SQL = {
  // Live availability: expired holds never count, even if their rows remain.
  availability: `
    SELECT p.id, p.name, p.event_date, p.doors_open, p.starts_at,
           p.capacity, p.price_piasters, p.enabled,
           MAX(0, p.capacity - COALESCE((
             SELECT SUM(r.quantity) FROM reservations r
             WHERE r.performance_id = p.id AND r.status = 'pending_payment' AND r.expires_at > ?
           ), 0)) AS available
    FROM performances p ORDER BY p.id`,
  performance: `SELECT * FROM performances WHERE id = ?`,
  reservationByKey: `SELECT * FROM reservations WHERE idempotency_key = ?`,
  reservationById: `SELECT * FROM reservations WHERE id = ?`,
  tickets: `SELECT ticket_number FROM reservation_tickets WHERE reservation_id = ? ORDER BY serial_number`,
  expireStale: `UPDATE reservations SET status = 'expired'
    WHERE performance_id = ? AND status = 'pending_payment' AND expires_at <= ?`,
  // Atomic capacity enforcement: writes a row only when enough unexpired inventory
  // exists AT EXECUTION TIME inside the batch transaction. 0 changes => rejected.
  insertReservation: `
    INSERT INTO reservations
      (id, idempotency_key, performance_id, quantity, total_piasters, status, created_at, expires_at)
    SELECT ?, ?, p.id, ?, p.price_piasters * ?, 'pending_payment', ?, ?
    FROM performances p
    WHERE p.id = ? AND p.enabled = 1 AND p.price_piasters > 0 AND p.capacity > 0
      AND p.capacity - COALESCE((
            SELECT SUM(r.quantity) FROM reservations r
            WHERE r.performance_id = p.id AND r.status = 'pending_payment' AND r.expires_at > ?
          ), 0) >= ?`,
  // Provisional per-attendee numbers from the performance's own sequence.
  insertTickets: `
    INSERT INTO reservation_tickets
      (reservation_id, performance_id, serial_number, ticket_number, created_at)
    WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ? - 1)
    SELECT r.id, r.performance_id, s.next_serial + seq.i,
           'MSD-2026-' || r.performance_id || '-' || printf('%04d', s.next_serial + seq.i), ?
    FROM reservations r
    JOIN sequences s ON s.performance_id = r.performance_id
    CROSS JOIN seq WHERE r.id = ?`,
  bumpSequence: `UPDATE sequences SET next_serial = next_serial + ?
    WHERE performance_id = ? AND EXISTS (SELECT 1 FROM reservations WHERE id = ?)`,
};

export function validateReservationInput(body, cfg) {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return { code: 'INVALID_BODY', message: 'طلب غير صالح.' };
  const { performance_id: pid, quantity, idempotency_key: key } = body;
  if (typeof pid !== 'string' || !/^[A-Za-z0-9_-]{1,8}$/.test(pid))
    return { code: 'INVALID_PERFORMANCE', message: 'معرّف العرض غير صالح.' };
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > cfg.maxPerBooking)
    return { code: 'INVALID_QUANTITY', message: `عدد التذاكر يجب أن يكون رقمًا صحيحًا بين 1 و${cfg.maxPerBooking}.` };
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(key))
    return { code: 'INVALID_IDEMPOTENCY_KEY', message: 'مفتاح الحجز غير صالح.' };
  return null;
}

function newReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = ''; for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return 'MSD-' + s;
}

function shapeReservation(row, ticketNumbers, now) {
  const expired = row.status === 'expired' || row.expires_at <= now;
  return {
    reference: row.id, performance_id: row.performance_id, quantity: row.quantity,
    unit_price_piasters: row.total_piasters / row.quantity, // exact: total = unit * qty
    total_piasters: row.total_piasters, ticket_numbers: ticketNumbers,
    status: expired ? 'expired' : 'pending_payment',
    created_at: row.created_at, expires_at: row.expires_at,
    expires_at_iso: new Date(row.expires_at * 1000).toISOString(),
  };
}

async function ticketsOf(db, ref) {
  return (await db.prepare(SQL.tickets).bind(ref).all()).results.map(t => t.ticket_number);
}

async function replay(db, row, pid, quantity, now) {
  if (row.performance_id !== pid || row.quantity !== quantity)
    return { status: 409, body: { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT',
      message: 'مفتاح الحجز مستخدم بالفعل بطلب مختلف. ابدأ حجزًا جديدًا.' } } };
  return { status: 200, body: { ok: true, idempotent_replay: true,
    reservation: shapeReservation(row, await ticketsOf(db, row.id), now) } };
}

export async function availabilityPayload(db, cfg) {
  const now = Math.floor(Date.now() / 1000);
  const rows = (await db.prepare(SQL.availability).bind(now).all()).results;
  const performances = rows.map(r => {
    const configured = r.enabled === 1 && r.capacity > 0 && r.price_piasters > 0;
    return { id: r.id, name: r.name, event_date: r.event_date,
      doors_open: r.doors_open, starts_at: r.starts_at,
      capacity: r.capacity, price_piasters: r.price_piasters,
      available: r.available, enabled: r.enabled === 1, configured,
      bookable: configured && cfg.bookingOpen && r.available > 0 };
  });
  return { ok: true, event: EVENT,
    booking_open: cfg.bookingOpen && performances.some(p => p.configured),
    config: { instapay_address: cfg.instapay, whatsapp_number: cfg.whatsapp,
      reservation_minutes: cfg.ttlMinutes, max_per_booking: cfg.maxPerBooking },
    performances, server_time: new Date().toISOString() };
}

export async function createReservation(db, cfg, body) {
  const now = Math.floor(Date.now() / 1000);
  const invalid = validateReservationInput(body, cfg);
  if (invalid) return { status: 400, body: { ok: false, error: invalid } };
  if (!cfg.bookingOpen) return { status: 503, body: { ok: false, error: {
    code: 'BOOKING_CLOSED', message: 'الحجز غير مفتوح حاليًا.' } } };

  const { performance_id: pid, quantity, idempotency_key: key } = body;

  const existing = await db.prepare(SQL.reservationByKey).bind(key).first();
  if (existing) return replay(db, existing, pid, quantity, now);

  const perf = await db.prepare(SQL.performance).bind(pid).first();
  if (!perf) return { status: 404, body: { ok: false, error: {
    code: 'INVALID_PERFORMANCE', message: 'العرض غير موجود.' } } };
  if (!perf.enabled || perf.price_piasters <= 0 || perf.capacity <= 0)
    return { status: 409, body: { ok: false, error: {
      code: 'PERFORMANCE_DISABLED', message: 'هذا العرض غير متاح للحجز حاليًا.' } } };

  const expires = now + cfg.ttlMinutes * 60;

  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = newReference();
    // One D1 batch = one transaction; any failed statement rolls back everything.
    // Statements 2-4 are no-ops unless the conditional INSERT created the row,
    // so a capacity rejection leaves zero side effects.
    const statements = [
      db.prepare(SQL.expireStale).bind(pid, now),
      db.prepare(SQL.insertReservation).bind(ref, key, quantity, quantity, now, expires, pid, now, quantity),
      db.prepare(SQL.insertTickets).bind(quantity, now, ref),
      db.prepare(SQL.bumpSequence).bind(quantity, pid, ref),
    ];
    let results;
    try { results = await db.batch(statements); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (msg.includes('reservations.idempotency_key')) {
        const row = await db.prepare(SQL.reservationByKey).bind(key).first();
        if (row) return replay(db, row, pid, quantity, now);
      } else if (msg.includes('reservations.id')) { continue; } // rare ref collision: retry
      console.error('D1 batch failed:', msg);
      return { status: 500, body: { ok: false, error: {
        code: 'DATABASE_ERROR', message: 'حدث خطأ في قاعدة البيانات. حاول مرة أخرى.' } } };
    }

    if (results[1].meta.changes === 0) {
      const fresh = (await db.prepare(SQL.availability).bind(now).all()).results.find(r => r.id === pid);
      if (!fresh || fresh.enabled !== 1 || fresh.price_piasters <= 0)
        return { status: 409, body: { ok: false, error: {
          code: 'PERFORMANCE_DISABLED', message: 'هذا العرض غير متاح للحجز حاليًا.' } } };
      return { status: 409, body: { ok: false, error: { code: 'INSUFFICIENT_CAPACITY',
        message: `المتاح في هذا العرض ${fresh.available} تذكرة فقط. قلّل العدد وحاول مجددًا.` } } };
    }

    const row = await db.prepare(SQL.reservationById).bind(ref).first();
    return { status: 201, body: { ok: true, idempotent_replay: false,
      reservation: shapeReservation(row, await ticketsOf(db, ref), now) } };
  }
  return { status: 500, body: { ok: false, error: {
    code: 'DATABASE_ERROR', message: 'حدث خطأ في قاعدة البيانات. حاول مرة أخرى.' } } };
}
