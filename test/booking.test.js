// Automated booking-logic tests. Run: npm test  (Node >= 22.13, no dependencies)
// A tiny D1-compatible shim over node:sqlite executes the REAL SQL and the REAL
// request handlers. D1 serializes queries per database and runs batch() as one
// transaction — the shim mirrors both guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SQL, cleanName } from '../lib/core.js';
import { onRequestGet, onRequest as availFallback } from '../functions/api/availability.js';
import { onRequestPost, onRequest as resFallback } from '../functions/api/reservations.js';
import { formatEGP, formatTime, formatDateAr, normalizePhone } from '../public/js/format.js';
import { buildWhatsAppMessage, buildWhatsAppUrl } from '../public/js/whatsapp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  // tiny valid 1x1 jpeg data-uri, well under MAX_IMAGE_CHARS
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

class D1Statement {
  constructor(shim, sql) { this.shim = shim; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.shim.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { success: true, results: this.shim.db.prepare(this.sql).all(...this.args), meta: {} }; }
  async run() { return this._run(); }
  _run() {
    const r = this.shim.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

class D1Shim {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('PRAGMA foreign_keys = ON;'); }
  prepare(sql) { return new D1Statement(this, sql); }
  exec(sql) { this.db.exec(sql); }
  async batch(statements) { // one transaction, rollback on any failure (D1 semantics)
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(s._run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

function makeEnv(overrides = {}) {
  const db = new D1Shim();
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) {
    if (f.endsWith('.sql')) db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  const env = {
    DB: db,
    INSTAPAY_ADDRESS: 'example@instapay',   // dummy values — tests only
    WHATSAPP_NUMBER: '201000000000',        // dummy values — tests only
    RESERVATION_TTL_MINUTES: '15',
    MAX_TICKETS_PER_BOOKING: '10',
    BOOKING_ENABLED: 'true',
    ...overrides,
  };
  return { db, env };
}

function configure(db, { capA = 500, capB = 500, priceA = 5000, priceB = 5000, enA = 1, enB = 1 } = {}) {
  db.exec(`UPDATE performances SET capacity=${capA}, price_piasters=${priceA}, enabled=${enA} WHERE id='A';`);
  db.exec(`UPDATE performances SET capacity=${capB}, price_piasters=${priceB}, enabled=${enB} WHERE id='B';`);
}
const setTestMode = (db, on) => db.exec(`UPDATE settings SET value='${on ? '1' : '0'}' WHERE key='test_mode';`);

const avail = async (env) => (await (await onRequestGet({ env })).json());
const post = async (env, body) => {
  const res = await onRequestPost({
    request: new Request('https://test.local/api/reservations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    env,
  });
  return { status: res.status, data: await res.json() };
};
const booking = (pid, qty, key = crypto.randomUUID()) => ({
  performance_id: pid, quantity: qty, idempotency_key: key, customer_phone: '01012345678',
});
const count = (db, table) => db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('seed: both performances, correct times, booking closed until configured', async () => {
  const { env } = makeEnv();
  const a = await avail(env);
  assert.equal(a.ok, true);
  assert.equal(a.booking_open, false);
  assert.deepEqual(a.performances.map(p => p.id), ['A', 'B']);
  const [A, B] = a.performances;
  assert.equal(A.event_date, '2026-12-03');
  assert.equal(A.doors_open, '16:30'); assert.equal(A.starts_at, '17:00');
  assert.equal(B.doors_open, '18:30'); assert.equal(B.starts_at, '19:00');
  assert.equal(A.bookable, false); assert.equal(B.bookable, false);
  assert.equal(a.config.reservation_minutes, 15);
  assert.equal(a.config.max_per_booking, 10);
  assert.equal(a.config.test_mode, false);
});

test('configured performances open booking with independent inventories', async () => {
  const { db, env } = makeEnv(); configure(db);
  const a = await avail(env);
  assert.equal(a.booking_open, true);
  assert.equal(a.performances[0].available, 500);
  assert.equal(a.performances[1].available, 500);
  assert.equal(a.performances[0].price_piasters, 5000);
  assert.equal(a.performances[1].price_piasters, 5000);
});

test('combined capacity can never exceed 1000 (DB trigger)', () => {
  const { db } = makeEnv();
  db.exec("UPDATE performances SET capacity=600 WHERE id='A'");
  assert.throws(() => db.exec("UPDATE performances SET capacity=500 WHERE id='B'"), /1000/);
  db.exec("UPDATE performances SET capacity=400 WHERE id='B'"); // exactly 1000 is fine
});

test('3 tickets => 3 individual numbers, correct money and expiry', async () => {
  const { db, env } = makeEnv(); configure(db);
  const { status, data } = await post(env, booking('A', 3));
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  const r = data.reservation;
  assert.match(r.reference, /^MSD-[A-HJ-KM-NP-Z2-9]{6}$/);
  assert.deepEqual(r.ticket_numbers, ['MSD-2026-A-0001', 'MSD-2026-A-0002', 'MSD-2026-A-0003']);
  assert.equal(r.unit_price_piasters, 5000);
  assert.equal(r.total_piasters, 15000);
  assert.equal(r.status, 'pending_payment');
  assert.equal(r.expires_at - r.created_at, 15 * 60);
  assert.equal(count(db, 'reservation_tickets'), 3);
});

test('availability drops; A and B sequences independent', async () => {
  const { db, env } = makeEnv(); configure(db);
  await post(env, booking('A', 3));
  const b = await post(env, booking('B', 2));
  assert.deepEqual(b.data.reservation.ticket_numbers, ['MSD-2026-B-0001', 'MSD-2026-B-0002']);
  const a = await avail(env);
  assert.equal(a.performances[0].available, 497);
  assert.equal(a.performances[1].available, 498);
  const more = await post(env, booking('A', 1));
  for (const t of more.data.reservation.ticket_numbers) assert.match(t, /^MSD-2026-A-\d{4}$/);
});

test('idempotent replay returns same reservation', async () => {
  const { db, env } = makeEnv(); configure(db);
  const key = crypto.randomUUID();
  const first = await post(env, booking('A', 3, key));
  const second = await post(env, booking('A', 3, key));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.data.idempotent_replay, true);
  assert.equal(second.data.reservation.reference, first.data.reservation.reference);
  assert.deepEqual(second.data.reservation.ticket_numbers, first.data.reservation.ticket_numbers);
  assert.equal(count(db, 'reservations'), 1);
  assert.equal(count(db, 'reservation_tickets'), 3);
  assert.equal((await avail(env)).performances[0].available, 497);
});

test('idempotency conflict on different payload', async () => {
  const { db, env } = makeEnv(); configure(db);
  const key = crypto.randomUUID();
  await post(env, booking('A', 3, key));
  const { status, data } = await post(env, booking('A', 2, key));
  assert.equal(status, 409);
  assert.equal(data.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('concurrent duplicate submissions create exactly one reservation', async () => {
  const { db, env } = makeEnv(); configure(db);
  const key = crypto.randomUUID();
  const [r1, r2] = await Promise.all([post(env, booking('A', 2, key)), post(env, booking('A', 2, key))]);
  assert.equal(r1.data.ok, true); assert.equal(r2.data.ok, true);
  assert.equal(r1.data.reservation.reference, r2.data.reservation.reference);
  assert.equal(count(db, 'reservations'), 1);
  assert.equal(count(db, 'reservation_tickets'), 2);
});

test('server-side validation rejects bad input', async () => {
  const { db, env } = makeEnv(); configure(db);
  for (const q of [0, -1, 1.5, '3', 11, null]) {
    assert.equal((await post(env, booking('A', q))).status, 400, `qty ${q}`);
  }
  assert.equal((await post(env, booking('C', 1))).status, 404);
  assert.equal((await post(env, booking('A', 1, 'short'))).status, 400);
  assert.equal((await post(env, [])).data.error.code, 'INVALID_BODY');
  const badJson = await onRequestPost({
    request: new Request('https://t.local/x', { method: 'POST', body: 'not json' }), env,
  });
  assert.equal(badJson.status, 400);
  const big = await onRequestPost({
    request: new Request('https://t.local/x', { method: 'POST', body: 'x'.repeat(5000) }), env,
  });
  assert.equal(big.status, 413);
});

test('disabled performance rejects bookings', async () => {
  const { db, env } = makeEnv(); configure(db, { enB: 0 });
  const { status, data } = await post(env, booking('B', 1));
  assert.equal(status, 409);
  assert.equal(data.error.code, 'PERFORMANCE_DISABLED');
});

test('exceeding capacity rejected with zero side effects', async () => {
  const { db, env } = makeEnv(); configure(db, { capA: 2 });
  const { status, data } = await post(env, booking('A', 3));
  assert.equal(status, 409);
  assert.equal(data.error.code, 'INSUFFICIENT_CAPACITY');
  assert.equal(count(db, 'reservations'), 0);
  assert.equal(count(db, 'reservation_tickets'), 0);
  const ok = await post(env, booking('A', 2)); // failed attempt consumed no serials
  assert.deepEqual(ok.data.reservation.ticket_numbers, ['MSD-2026-A-0001', 'MSD-2026-A-0002']);
});

test('two competitors for last ticket cannot overbook', async () => {
  const { db, env } = makeEnv(); configure(db, { capA: 1, capB: 0, enB: 0 });
  const [r1, r2] = await Promise.all([post(env, booking('A', 1)), post(env, booking('A', 1))]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
  const loser = r1.status === 409 ? r1 : r2;
  assert.equal(loser.data.error.code, 'INSUFFICIENT_CAPACITY');
  assert.equal((await avail(env)).performances[0].available, 0);
  assert.equal(count(db, 'reservation_tickets'), 1);
});

test('SQL-level race: only one conditional batch wins', async () => {
  const { db } = makeEnv(); configure(db, { capA: 1 });
  const now = Math.floor(Date.now() / 1000);
  const mk = (ref, key) => [
    db.prepare(SQL.expireStale).bind('A', now),
    db.prepare(SQL.insertReservation).bind(ref, key, 1, 1, now, now + 900, null, '201012345678', 'A', now, 1),
    db.prepare(SQL.insertTickets).bind(1, now, ref),
    db.prepare(SQL.bumpSequence).bind(1, 'A', ref),
  ];
  const r1 = await db.batch(mk('MSD-TEST01', 'race-key-1'));
  const r2 = await db.batch(mk('MSD-TEST02', 'race-key-2'));
  assert.equal(r1[1].meta.changes, 1);
  assert.equal(r2[1].meta.changes, 0);
  assert.equal(count(db, 'reservations'), 1);
  assert.equal(count(db, 'reservation_tickets'), 1);
});

test('expired holds restore inventory; serials never reused; lazy status flip', async () => {
  const { db, env } = makeEnv(); configure(db, { capA: 2 });
  const first = await post(env, booking('A', 2));
  assert.equal((await avail(env)).performances[0].available, 0);
  db.exec(`UPDATE reservations SET expires_at = ${Math.floor(Date.now() / 1000) - 10}`);
  assert.equal((await avail(env)).performances[0].available, 2); // no cleanup job needed
  const second = await post(env, booking('A', 1));
  assert.deepEqual(second.data.reservation.ticket_numbers, ['MSD-2026-A-0003']); // gap, not reuse
  const old = db.db.prepare('SELECT status FROM reservations WHERE id = ?').get(first.data.reservation.reference);
  assert.equal(old.status, 'expired');
  assert.equal(count(db, 'reservation_tickets'), 3); // old numbers still on record
});

test('replaying expired reservation reports expired', async () => {
  const { db, env } = makeEnv(); configure(db);
  const key = crypto.randomUUID();
  await post(env, booking('A', 1, key));
  db.exec(`UPDATE reservations SET expires_at = ${Math.floor(Date.now() / 1000) - 10}`);
  const replay = await post(env, booking('A', 1, key));
  assert.equal(replay.status, 200);
  assert.equal(replay.data.reservation.status, 'expired');
});

test('booking closed until placeholders filled', async () => {
  for (const o of [{ WHATSAPP_NUMBER: '' }, { INSTAPAY_ADDRESS: '' }, { BOOKING_ENABLED: 'false' }]) {
    const { db, env } = makeEnv(o); configure(db);
    assert.equal((await avail(env)).booking_open, false);
    const { status, data } = await post(env, booking('A', 1));
    assert.equal(status, 503);
    assert.equal(data.error.code, 'BOOKING_CLOSED');
  }
});

test('per-booking limit and TTL configurable', async () => {
  const { db, env } = makeEnv({ MAX_TICKETS_PER_BOOKING: '5', RESERVATION_TTL_MINUTES: '5' });
  configure(db);
  assert.equal((await post(env, booking('A', 6))).status, 400);
  const ok = await post(env, booking('A', 5));
  assert.equal(ok.status, 201);
  assert.equal(ok.data.reservation.expires_at - ok.data.reservation.created_at, 300);
});

test('batch rollback: duplicate key leaves no orphan rows', async () => {
  const { db, env } = makeEnv(); configure(db);
  const key = crypto.randomUUID();
  await post(env, booking('A', 1, key));
  const now = Math.floor(Date.now() / 1000);
  const ref = 'MSD-DUPKEY';
  await assert.rejects(db.batch([
    db.prepare(SQL.expireStale).bind('A', now),
    db.prepare(SQL.insertReservation).bind(ref, key, 1, 1, now, now + 900, null, '201012345678', 'A', now, 1),
    db.prepare(SQL.insertTickets).bind(1, now, ref),
    db.prepare(SQL.bumpSequence).bind(1, 'A', ref),
  ]), /idempotency_key/);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE id = ?').get(ref).n, 0);
  assert.equal(db.db.prepare("SELECT next_serial FROM sequences WHERE performance_id='A'").get().next_serial, 2);
});

test('batch rollback: ticket collision rolls back reservation AND sequence', async () => {
  const { db, env } = makeEnv(); configure(db);
  const first = await post(env, booking('A', 1));
  // Sabotage: pre-occupy the next ticket number so insertTickets fails mid-batch.
  db.db.prepare('INSERT INTO reservation_tickets (reservation_id, performance_id, serial_number, ticket_number, created_at) VALUES (?,?,?,?,?)')
    .run(first.data.reservation.reference, 'A', 99, 'MSD-2026-A-0002', 0);
  const { status, data } = await post(env, booking('A', 1));
  assert.equal(status, 500);
  assert.equal(data.error.code, 'DATABASE_ERROR');
  assert.equal(count(db, 'reservations'), 1); // failed reservation rolled back
  assert.equal(db.db.prepare("SELECT next_serial FROM sequences WHERE performance_id='A'").get().next_serial, 2);
});

test('method guards', async () => {
  assert.equal((await resFallback()).status, 405);
  assert.equal((await availFallback()).status, 405);
});

test('public availability exposes no private data', async () => {
  const { db, env } = makeEnv(); configure(db);
  const key = crypto.randomUUID();
  const { data } = await post(env, { ...booking('A', 2, key), customer_name: 'حسن وائل', customer_phone: '01099887766' });
  const raw = JSON.stringify(await avail(env));
  assert.ok(!raw.includes(key));
  assert.ok(!raw.includes(data.reservation.reference));
  assert.ok(!raw.includes('MSD-2026-A-0001'));
  assert.ok(!raw.includes('حسن'));
  assert.ok(!raw.includes('201099887766'));
  const cols = db.db.prepare('PRAGMA table_info(reservations)').all().map(c => c.name);
  assert.deepEqual(cols, ['id', 'idempotency_key', 'performance_id', 'quantity', 'total_piasters',
    'status', 'created_at', 'expires_at', 'customer_name', 'customer_phone']);
});

test('money and time formatting', () => {
  assert.equal(formatEGP(15000), '150');
  assert.equal(formatEGP(5000), '50');
  assert.equal(formatEGP(12550), '125.50');
  assert.equal(formatEGP(50), '0.50');
  assert.equal(formatTime('16:30'), '4:30 م');
  assert.equal(formatTime('17:00'), '5:00 م');
  assert.equal(formatTime('18:30'), '6:30 م');
  assert.equal(formatTime('19:00'), '7:00 م');
  const d = formatDateAr('2026-12-03');
  assert.ok(d.includes('الخميس') && d.includes('3') && d.includes('ديسمبر') && d.includes('2026'), d);
});

test('WhatsApp message has all details, no date line; URL round-trips', async () => {
  const { db, env } = makeEnv(); configure(db);
  const { data } = await post(env, booking('A', 3));
  const a = await avail(env);
  const msg = buildWhatsAppMessage({
    event: a.event, performance: a.performances[0], reservation: data.reservation,
    customerName: 'هانتر', customerPhone: '201012345678',
  });
  for (const n of ['مكتب حل المشاكل التافهة', 'هانتر', 'رقم الموبايل: 201012345678', 'A', 'العرض الأول',
    '4:30 م', '5:00 م', '3', data.reservation.reference,
    'MSD-2026-A-0001', 'MSD-2026-A-0002', 'MSD-2026-A-0003', '150', 'راجعوا']) {
    assert.ok(msg.includes(n), `missing ${n}`);
  }
  assert.ok(!msg.includes('التاريخ:'), 'date line must be absent');
  assert.ok(!msg.includes('2026-12-03'), 'raw event date must be absent');
  const url = buildWhatsAppUrl(a.config.whatsapp_number, msg);
  assert.ok(url.startsWith('https://wa.me/201000000000?text='));
  assert.equal(decodeURIComponent(url.split('?text=')[1]), msg);
  const bare = buildWhatsAppMessage({
    event: a.event, performance: a.performances[0], reservation: data.reservation,
    customerName: '', customerPhone: '',
  });
  assert.ok(!bare.includes('الاسم:'));
  assert.ok(!bare.includes('رقم الموبايل:'));
});

test('booker name stored on reservation and every ticket, never exposed publicly', async () => {
  const { db, env } = makeEnv(); configure(db);
  const { status, data } = await post(env, { ...booking('A', 2), customer_name: '  حسن   وائل \n' });
  assert.equal(status, 201);
  assert.ok(!('customer_name' in data.reservation), 'name must not be echoed in the API response');
  const row = db.db.prepare('SELECT customer_name FROM reservations WHERE id = ?').get(data.reservation.reference);
  assert.equal(row.customer_name, 'حسن وائل');
  const names = db.db.prepare('SELECT customer_name FROM reservation_tickets WHERE reservation_id = ?').all(data.reservation.reference);
  assert.equal(names.length, 2);
  for (const n of names) assert.equal(n.customer_name, 'حسن وائل');
  assert.ok(!JSON.stringify(await avail(env)).includes('حسن'));

  const anonymous = await post(env, booking('A', 1));
  assert.equal(anonymous.status, 201);
  assert.equal(
    db.db.prepare('SELECT customer_name FROM reservations WHERE id = ?').get(anonymous.data.reservation.reference).customer_name,
    null
  );

  const bad = await post(env, { ...booking('A', 1), customer_name: 123 });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'INVALID_NAME');
});

test('cleanName sanitizes input', () => {
  assert.equal(cleanName('  حسن   وائل \n'), 'حسن وائل');
  assert.equal(cleanName('حسن\u0000وائل'), 'حسن وائل');
  assert.equal(cleanName('a\tb\rc'), 'a b c');
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('    '), null);
  assert.equal(cleanName(null), null);
  assert.equal(cleanName(undefined), null);
  assert.equal(cleanName(123), null);
  assert.equal(cleanName('ا'.repeat(100)).length, 60);
});

test('normalizePhone handles Arabic digits, separators and Egyptian canonicalization', () => {
  assert.equal(normalizePhone('01012345678'), '201012345678');
  assert.equal(normalizePhone('010 1234 5678'), '201012345678');
  assert.equal(normalizePhone('+20 101-234-5678'), '201012345678');
  assert.equal(normalizePhone('00201012345678'), '201012345678');
  assert.equal(normalizePhone('٠١٠١٢٣٤٥٦٧٨'), '201012345678');
  assert.equal(normalizePhone('(010) 1234 5678'), '201012345678');
  assert.equal(normalizePhone('201012345678'), '201012345678');
  assert.equal(normalizePhone('12345678'), '12345678');       // 8 digits allowed
  assert.equal(normalizePhone('1234567'), null);              // too short
  assert.equal(normalizePhone('1'.repeat(16)), null);         // too long
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(123), null);
});

test('booker phone is required, normalized, stored on both tables, never public', async () => {
  const { db, env } = makeEnv(); configure(db);
  const { status, data } = await post(env, { ...booking('A', 2), customer_name: 'حسن وائل', customer_phone: '٠١٠ ١٢٣٤ ٥٦٧٨' });
  assert.equal(status, 201);
  assert.ok(!('customer_phone' in data.reservation), 'phone must not be echoed in the API response');
  const row = db.db.prepare('SELECT customer_phone FROM reservations WHERE id = ?').get(data.reservation.reference);
  assert.equal(row.customer_phone, '201012345678');
  const rows = db.db.prepare('SELECT customer_phone FROM reservation_tickets WHERE reservation_id = ?').all(data.reservation.reference);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.customer_phone, '201012345678');
  assert.ok(!JSON.stringify(await avail(env)).includes('201012345678'));

  for (const bad of [undefined, null, '', '   ', 'abc', '123', 12345678]) {
    const body = { ...booking('A', 1) };
    if (bad === undefined) delete body.customer_phone; else body.customer_phone = bad;
    const res = await post(env, body);
    assert.equal(res.status, 400, `phone ${JSON.stringify(bad)}`);
    assert.equal(res.data.error.code, 'INVALID_PHONE');
  }
  assert.equal(count(db, 'reservations'), 1); // rejected attempts created nothing
});

test('test mode opens booking without contact details', async () => {
  const { db, env } = makeEnv({ INSTAPAY_ADDRESS: '', WHATSAPP_NUMBER: '' });
  configure(db);
  assert.equal((await avail(env)).booking_open, false);
  setTestMode(db, true);
  const a = await avail(env);
  assert.equal(a.booking_open, true);
  assert.equal(a.config.test_mode, true);
  assert.equal(a.config.instapay_address, '');
  assert.equal(a.config.whatsapp_number, '');
  assert.equal(a.performances[0].bookable, true);
  const { status, data } = await post(env, { ...booking('A', 1), customer_name: 'تجربة' });
  assert.equal(status, 201);
  assert.equal(data.reservation.ticket_numbers.length, 1);
  setTestMode(db, false);
  assert.equal((await avail(env)).booking_open, false);
  assert.equal((await post(env, booking('A', 1))).status, 503);
});

test('test mode respects the global kill-switch', async () => {
  const { db, env } = makeEnv({ BOOKING_ENABLED: 'false', INSTAPAY_ADDRESS: '', WHATSAPP_NUMBER: '' });
  configure(db);
  setTestMode(db, true);
  assert.equal((await avail(env)).booking_open, false);
  const { status, data } = await post(env, booking('A', 1));
  assert.equal(status, 503);
  assert.equal(data.error.code, 'BOOKING_CLOSED');
});

test('idempotent replay keeps the originally stored name and phone', async () => {
  const { db, env } = makeEnv(); configure(db);
  const key = crypto.randomUUID();
  const first = await post(env, { ...booking('A', 1, key), customer_name: 'حسن وائل', customer_phone: '01012345678' });
  assert.equal(first.status, 201);
  const replay = await post(env, { ...booking('A', 1, key), customer_name: 'اسم آخر', customer_phone: '01199998888' });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.idempotent_replay, true);
  assert.equal(replay.data.reservation.reference, first.data.reservation.reference);
  const row = db.db.prepare('SELECT customer_name, customer_phone FROM reservations WHERE id = ?').get(first.data.reservation.reference);
  assert.equal(row.customer_name, 'حسن وائل');
  assert.equal(row.customer_phone, '201012345678');
  assert.equal(count(db, 'reservations'), 1);
});
