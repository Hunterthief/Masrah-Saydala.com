// Shared backend core: Cloudflare Pages Functions + Node test suite.
// Pure ESM, parameterized SQL.
//
// SCHEMA REALITY (from the live reservations table):
//   - expires_at INTEGER NOT NULL  -> we MUST supply it; there is no expiry logic,
//     so we write the NO_EXPIRY sentinel (year 2100) and never read it.
//   - status CHECK IN ('pending_payment','expired')  -> there is NO 'confirmed'
//     and NO 'cancelled'. 'pending_payment' = held (verified flag says reviewed or
//     not); 'expired' = released/cancelled (repurposed, since nothing auto-expires).
//     Therefore every availability/count query uses status = 'pending_payment',
//     NOT status <> 'cancelled' (the latter would wrongly keep released seats busy).
//   - customer_name / customer_phone / payment_image are nullable -> cleanName may
//     return null; that is correct and must NOT be coerced to ''.
//   - verified INTEGER NOT NULL DEFAULT 0 -> organizer confirmation flag (added via
//     ALTER TABLE; read by /review, never returned to the public API).
//
// TICKET NUMBERING:
//   Old behavior: always continue from sequences.next_serial.
//   New behavior: reuse the lowest unused serial number for that performance.
//
//   Example:
//     Active tickets: 1,2,3,4,5
//     Delete ticket 1 completely.
//     Next booking gets 1.
//     Next booking after that gets 6, assuming 2-5 are still active.
//
//   This is safe only because canceled bookings are deleted completely from both
//   reservations and reservation_tickets. If canceled rows are kept as history,
//   their ticket numbers must not be reused.
//
// The ONLY db write is the on-site "attach screenshot + record" press. The screenshot
// is stored (compressed, canvas-sanitized) on the reservation row.
import { normalizePhone } from '../public/js/format.js';

export const EVENT = {
  name: 'مكتب حل المشاكل التافهة',
  organizer: 'فريق مسرح صيدلة إسكندرية — كلية الصيدلة، جامعة الإسكندرية',
  date: '2026-12-03', timezone: 'Africa/Cairo',
  venue: 'كلية الصيدلة — المبنى الجديد — الدور الثالث',
};

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const NAME_MAX = 60;

// Abuse rails, NOT business limits. The real cap on a booking is remaining seats
// (enforced by the conditional INSERT). These only stop a malformed/huge payload
// from generating an enormous recursive CTE or an oversized D1 request.
export const MAX_QUANTITY = 100;            // per-request sanity ceiling
export const MAX_IMAGE_CHARS = 360_000;     // ~270KB raw once base64-decoded
export const NO_EXPIRY = 4102444800;        // 2100-01-01; vestigial column, no expiry logic reads it

function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// customer_name is nullable in the live schema, so an omitted/blank name is null
// (NOT ''). Do not coerce to '' — null is valid and keeps the row honest.
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s.length ? s : null;
}

// A stored payment image must be a bare image data-URI (jpeg/png/webp), nothing else.
// This is what keeps /review and /api/payment from ever emitting a non-image src.
export function isValidImage(s) {
  return typeof s === 'string'
    && s.length <= MAX_IMAGE_CHARS
    && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s);
}

// Booking readiness no longer depends on a WhatsApp number (the customer never
// messages WhatsApp anymore). It needs a transfer destination so the buyer can
// see where to pay — unless test mode is on.
export function readConfig(env) {
  const instapay = String(env.INSTAPAY_ADDRESS ?? '').trim();
  const whatsappRaw = String(env.WHATSAPP_NUMBER ?? '').replace(/\D/g, '');
  const whatsapp = /^\d{8,15}$/.test(whatsappRaw) ? whatsappRaw : '';
  const flagOn = String(env.BOOKING_ENABLED ?? 'true').toLowerCase() !== 'false';
  return {
    instapay,
    whatsapp,                 // optional: only powers the organizer contact link
    payReady: instapay.length > 0,
    flagOn,
    testMode: false,
    bookingOpen: flagOn && false, // refined in loadConfig once test_mode is read
  };
}

export async function loadConfig(db, env) {
  const cfg = readConfig(env);
  let testMode = false;
  try {
    const row = await db.prepare(SQL.setting).bind('test_mode').first();
    testMode = !!row && String(row.value) === '1';
  } catch { testMode = false; }
  return { ...cfg, testMode, bookingOpen: cfg.flagOn && (testMode || cfg.payReady) };
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
export const err = (status, code, message) => json({ ok: false, error: { code, message } }, status);

// Constant-ish time string compare for the review token (avoids early-exit leaks).
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const SQL = {
  setting: `SELECT value FROM settings WHERE key = ?`,

  // Count ONLY active holds. 'expired' rows are released seats and must NOT reduce
  // availability. (The old `<> 'cancelled'` was wrong: 'cancelled' can never exist in
  // this schema, so it silently included 'expired' and froze released seats.)
  availability: `
    SELECT p.id, p.name, p.event_date, p.doors_open, p.starts_at,
           p.capacity, p.price_piasters, p.enabled,
           MAX(0, p.capacity - COALESCE((
             SELECT SUM(r.quantity) FROM reservations r
             WHERE r.performance_id = p.id AND r.status = 'pending_payment'
           ), 0)) AS available
    FROM performances p ORDER BY p.id
  `,

  performance: `SELECT * FROM performances WHERE id = ?`,
  reservationByKey: `SELECT * FROM reservations WHERE idempotency_key = ?`,
  reservationById: `SELECT * FROM reservations WHERE id = ?`,
  tickets: `SELECT ticket_number FROM reservation_tickets WHERE reservation_id = ? ORDER BY serial_number`,

  // Review list: metadata only (images stream separately via /api/payment).
  // Includes `verified` so /review can distinguish held vs confirmed.
  reservationsAll: `
    SELECT id, performance_id, quantity, total_piasters, status, created_at,
           verified, customer_name, customer_phone,
           (payment_image IS NOT NULL AND payment_image <> '') AS has_image
    FROM reservations ORDER BY created_at DESC LIMIT 1000
  `,
  paymentImage: `SELECT payment_image FROM reservations WHERE id = ?`,

  // expires_at is NOT NULL with no default -> we MUST bind NO_EXPIRY here.
  // Capacity subquery counts active holds only (= 'pending_payment').
  insertReservation: `
    INSERT INTO reservations
      (id, idempotency_key, performance_id, quantity, total_piasters,
       status, created_at, expires_at, customer_name, customer_phone, payment_image)
    SELECT ?, ?, p.id, ?, p.price_piasters * ?,
           'pending_payment', ?, ?, ?, ?, ?
    FROM performances p
    WHERE p.id = ?
      AND p.enabled = 1
      AND p.price_piasters > 0
      AND p.capacity > 0
      AND p.capacity - COALESCE((
            SELECT SUM(r.quantity) FROM reservations r
            WHERE r.performance_id = p.id AND r.status = 'pending_payment'
          ), 0) >= ?
  `,

  // GAP-FILLING TICKET ALLOCATOR.
  //
  // Instead of using sequences.next_serial as the source of truth, this generates
  // candidate serial numbers from 1 up to the performance capacity, excludes any
  // serial already present in reservation_tickets, and takes the lowest free ones.
  //
  // Example:
  //   Existing tickets: 2,3,4,5
  //   Requested quantity: 1
  //   Free serials: 1,6,7,... up to capacity
  //   Allocated: 1
  //
  // Example:
  //   Existing tickets: 1,3,5
  //   Requested quantity: 2
  //   Free serials: 2,4,6,...
  //   Allocated: 2 and 4
  //
  // Note: if deleted holes are scattered, tickets inside one booking may not be
  // consecutive. If you require strictly consecutive tickets inside each booking,
  // this needs a contiguous-block allocator instead.
  insertTickets: `
    WITH RECURSIVE cand(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1
      FROM cand, performances p
      WHERE p.id = ?
        AND n < p.capacity
    ), free AS (
      SELECT n AS serial
      FROM cand
      WHERE NOT EXISTS (
        SELECT 1
        FROM reservation_tickets t
        WHERE t.performance_id = ?
          AND t.serial_number = cand.n
      )
      ORDER BY n
      LIMIT ?
    )
    INSERT INTO reservation_tickets
      (reservation_id, performance_id, serial_number, ticket_number,
       created_at, customer_name, customer_phone)
    SELECT r.id,
           r.performance_id,
           f.serial,
           'MSD-2026-' || r.performance_id || '-' || printf('%04d', f.serial),
           ?,
           r.customer_name,
           r.customer_phone
    FROM reservations r
    CROSS JOIN free f
    WHERE r.id = ?
  `,

  // Keep sequences informational only: next_serial = highest existing serial + 1.
  // This is no longer used to allocate new tickets, but keeping it synced avoids
  // confusion if you inspect the table manually.
  syncSequence: `
    UPDATE sequences
    SET next_serial = COALESCE((
      SELECT MAX(t.serial_number)
      FROM reservation_tickets t
      WHERE t.performance_id = ?
    ), 0) + 1
    WHERE performance_id = ?
  `,
};

export function validateReservationInput(body, cfg) {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return { code: 'INVALID_BODY', message: 'طلب غير صالح.' };

  const { performance_id: pid, quantity, idempotency_key: key, customer_name: name } = body;

  if (typeof pid !== 'string' || !/^[A-Za-z0-9_-]{1,8}$/.test(pid))
    return { code: 'INVALID_PERFORMANCE', message: 'معرّف العرض غير صالح.' };

  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY)
    return { code: 'INVALID_QUANTITY', message: 'عدد التذاكر يجب أن يكون رقمًا صحيحًا لا يقل عن 1.' };

  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(key))
    return { code: 'INVALID_IDEMPOTENCY_KEY', message: 'مفتاح الحجز غير صالح.' };

  if (name !== undefined && name !== null && typeof name !== 'string')
    return { code: 'INVALID_NAME', message: 'الاسم غير صالح.' };

  if (!normalizePhone(body.customer_phone))
    return { code: 'INVALID_PHONE', message: 'رقم الموبايل مطلوب لمطابقة الدفع (مثال: 01012345678).' };

  // The screenshot is what triggers the save — it is mandatory.
  if (!isValidImage(body.payment_image))
    return { code: 'INVALID_IMAGE', message: 'أرفق صورة دفع إنستاباي (PNG أو JPG) قبل التسجيل.' };

  return null;
}

function newReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return 'MSD-' + s;
}

// NOTE: payment_image AND verified are intentionally NOT returned to the public API.
// A fresh booking is always status='pending_payment', verified=0 (unreviewed).
function shapeReservation(row, ticketNumbers) {
  return {
    reference: row.id,
    performance_id: row.performance_id,
    quantity: row.quantity,
    unit_price_piasters: row.total_piasters / row.quantity,
    total_piasters: row.total_piasters,
    ticket_numbers: ticketNumbers,
    status: row.status,
    created_at: row.created_at,
    has_image: !!(row.payment_image),
  };
}

async function ticketsOf(db, ref) {
  return (await db.prepare(SQL.tickets).bind(ref).all()).results.map(t => t.ticket_number);
}

async function replay(db, row, pid, quantity) {
  if (row.performance_id !== pid || row.quantity !== quantity)
    return { status: 409, body: { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'مفتاح الحجز مستخدم بالفعل بطلب مختلف. ابدأ حجزًا جديدًا.' } } };
  return { status: 200, body: { ok: true, idempotent_replay: true, reservation: shapeReservation(row, await ticketsOf(db, row.id)) } };
}

export async function availabilityPayload(db, cfg) {
  const rows = (await db.prepare(SQL.availability).all()).results;
  const performances = rows.map(r => {
    const configured = r.enabled === 1 && r.capacity > 0 && r.price_piasters > 0;
    return {
      id: r.id, name: r.name, event_date: r.event_date, doors_open: r.doors_open, starts_at: r.starts_at,
      capacity: r.capacity, price_piasters: r.price_piasters, available: r.available,
      enabled: r.enabled === 1, configured, bookable: configured && cfg.bookingOpen && r.available > 0,
    };
  });
  return {
    ok: true, event: EVENT,
    booking_open: cfg.bookingOpen && performances.some(p => p.configured),
    config: { instapay_address: cfg.instapay, whatsapp_number: cfg.whatsapp, test_mode: cfg.testMode },
    performances,
    server_time: new Date().toISOString(),
  };
}

export async function createReservation(db, cfg, body) {
  const now = Math.floor(Date.now() / 1000);

  const invalid = validateReservationInput(body, cfg);
  if (invalid) return { status: 400, body: { ok: false, error: invalid } };

  if (!cfg.bookingOpen)
    return { status: 503, body: { ok: false, error: { code: 'BOOKING_CLOSED', message: 'الحجز غير مفتوح حاليًا.' } } };

  const { performance_id: pid, quantity, idempotency_key: key, payment_image: image } = body;
  const customerName = cleanName(body.customer_name);   // may be null; column is nullable
  const customerPhone = normalizePhone(body.customer_phone);

  try {
    const existing = await db.prepare(SQL.reservationByKey).bind(key).first();
    if (existing) return replay(db, existing, pid, quantity);

    const perf = await db.prepare(SQL.performance).bind(pid).first();
    if (!perf) return { status: 404, body: { ok: false, error: { code: 'INVALID_PERFORMANCE', message: 'العرض غير موجود.' } } };
    if (!perf.enabled || perf.price_piasters <= 0 || perf.capacity <= 0)
      return { status: 409, body: { ok: false, error: { code: 'PERFORMANCE_DISABLED', message: 'هذا العرض غير متاح للحجز حاليًا.' } } };

    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = newReference();

      // insertReservation binds:
      // ref, key, quantity, total(quantity), created_at(now), expires_at(NO_EXPIRY),
      // customer_name, customer_phone, payment_image, performance_id(pid), capacity-check(quantity)
      //
      // insertTickets binds:
      // performance_id for candidate generation, performance_id for used-ticket exclusion,
      // quantity limit, created_at(now), reservation ref.
      //
      // syncSequence binds:
      // performance_id, performance_id.
      const statements = [
        db.prepare(SQL.insertReservation).bind(
          ref,
          key,
          quantity,
          quantity,
          now,
          NO_EXPIRY,
          customerName,
          customerPhone,
          image,
          pid,
          quantity
        ),
        db.prepare(SQL.insertTickets).bind(
          pid,
          pid,
          quantity,
          now,
          ref
        ),
        db.prepare(SQL.syncSequence).bind(
          pid,
          pid
        ),
      ];

      let results;
      try {
        results = await db.batch(statements);
      } catch (e) {
        const msg = String((e && e.message) || e);

        // Idempotency key race: another request already created this key.
        if (msg.includes('reservations.idempotency_key')) {
          const row = await db.prepare(SQL.reservationByKey).bind(key).first();
          if (row) return replay(db, row, pid, quantity);
        }

        // Reference collision OR ticket-number/serial collision from concurrent gap-fill.
        // Retry with a new reference and freshly computed free serials.
        if (
          msg.includes('reservations.id') ||
          msg.includes('reservation_tickets.ticket_number') ||
          msg.includes('reservation_tickets.serial_number') ||
          msg.includes('reservation_tickets.performance_id')
        ) {
          continue;
        }

        console.error('D1 batch failed:', msg);
        return {
          status: 500,
          body: {
            ok: false,
            error: {
              code: 'DATABASE_ERROR',
              message: 'حدث خطأ في قاعدة البيانات. حاول مرة أخرى.',
              detail: cfg.testMode ? msg : undefined,
            },
          },
        };
      }

      if (results[0].meta.changes === 0) {
        const fresh = (await db.prepare(SQL.availability).all()).results.find(r => r.id === pid);
        if (!fresh || fresh.enabled !== 1 || fresh.price_piasters <= 0) {
          return {
            status: 409,
            body: {
              ok: false,
              error: { code: 'PERFORMANCE_DISABLED', message: 'هذا العرض غير متاح للحجز حاليًا.' },
            },
          };
        }

        return {
          status: 409,
          body: {
            ok: false,
            error: {
              code: 'INSUFFICIENT_CAPACITY',
              message: `المتاح في هذا العرض ${fresh.available} تذكرة فقط. قلّل العدد وحاول مجددًا.`,
            },
          },
        };
      }

      // Safety net: if ticket allocation inserted fewer rows than requested, clean up
      // best-effort and fail. This should only happen if orphan tickets/capacity drift
      // exist. Normal deleted-and-purged bookings will not trigger this.
      if (results[1].meta.changes !== quantity) {
        console.error('Ticket allocation mismatch:', {
          pid,
          requested: quantity,
          inserted: results[1].meta.changes,
          ref,
        });

        try {
          await db.batch([
            db.prepare(`DELETE FROM reservation_tickets WHERE reservation_id = ?`).bind(ref),
            db.prepare(`DELETE FROM reservations WHERE id = ?`).bind(ref),
          ]);
        } catch (cleanupError) {
          console.error('Cleanup after ticket allocation mismatch failed:', cleanupError);
        }

        return {
          status: 500,
          body: {
            ok: false,
            error: {
              code: 'DATABASE_ERROR',
              message: 'حدث خطأ في قاعدة البيانات. حاول مرة أخرى.',
              detail: cfg.testMode
                ? `ticket allocation mismatch: requested ${quantity}, inserted ${results[1].meta.changes}`
                : undefined,
            },
          },
        };
      }

      const row = await db.prepare(SQL.reservationById).bind(ref).first();
      if (!row) {
        console.error('reservation row missing after successful insert:', ref);
        return {
          status: 500,
          body: {
            ok: false,
            error: {
              code: 'DATABASE_ERROR',
              message: 'حدث خطأ في قاعدة البيانات. حاول مرة أخرى.',
              detail: cfg.testMode ? 'reservation row missing after insert' : undefined,
            },
          },
        };
      }

      return {
        status: 201,
        body: {
          ok: true,
          idempotent_replay: false,
          reservation: shapeReservation(row, await ticketsOf(db, ref)),
        },
      };
    }

    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'حدث خطأ في قاعدة البيانات. حاول مرة أخرى.',
          detail: cfg.testMode ? 'reference/ticket collision retry exhausted' : undefined,
        },
      },
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error('createReservation unexpected failure:', msg);

    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'حدث خطأ في قاعدة البيانات. حاول مرة أخرى.',
          detail: cfg.testMode ? msg : undefined,
        },
      },
    };
  }
}

// Read-only helper for /review. Returns metadata + ticket numbers (no image bytes;
// those stream from /api/payment so the list page stays small). Rows carry `verified`
// and `status` ('pending_payment' | 'expired') for the review UI to label state.
export async function reviewList(db) {
  const rows = (await db.prepare(SQL.reservationsAll).all()).results;
  const out = [];
  for (const r of rows) out.push({ ...r, ticket_numbers: await ticketsOf(db, r.id) });
  return out;
}
