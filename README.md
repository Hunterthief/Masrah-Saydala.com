# مكتب حل المشاكل التافهة — Masrah Saydala

WhatsApp-first ticket booking page for the Pharmacy Theater Team (Faculty of Pharmacy,
Alexandria). One public purchase page. Payment is manual via **InstaPay**; confirmation and
final ticket delivery are manual via **WhatsApp**. No accounts, no admin dashboard, no payment
gateway, no ticket scanning.

| | |
|---|---|
| Event | مكتب حل المشاكل التافهة |
| Date | Thursday **3 December 2026** (`Africa/Cairo`) |
| Venue | Faculty of Pharmacy — New Building — Third Floor |
| Performance A | Doors **4:30 PM**, starts **5:00 PM** — 500 seats |
| Performance B | Doors **6:30 PM**, starts **7:00 PM** — 500 seats |
| Price | **50 EGP** per ticket (stored as `5000` piasters) |
| Event maximum | **1,000** tickets total (enforced by a DB trigger) |

## Stack

Cloudflare hosting (static `public/`) + serverless functions (`functions/`) + Cloudflare D1
(SQLite, binding `DB`). Vanilla HTML/CSS/JS, RTL Arabic, no runtime CDN, no paid services.
Money is stored as integer **piasters** (1 EGP = 100).

## Repository layout

    public/                     index.html, css/, js/, assets/, _headers   (static output)
    public/assets/images/       poster.jpg, poster-b.jpg                   (official posters)
    functions/api/              availability.js, reservations.js           (request handlers)
    lib/core.js                 shared backend logic + all SQL (used by handlers AND tests)
    migrations/                 0001 … 0005 (schema, seed, test mode, name, phone)
    test/booking.test.js        30 automated tests (node --test, D1 shim over node:sqlite)
    src/worker.js               only present if deployed as a Worker (see Deploy)
    wrangler.jsonc              hosting config + D1 binding + public vars

---

# Setup — GUI only (no terminal required)

Everything below is done in the **Cloudflare dashboard** and the **GitHub web editor**.
CLI equivalents are listed at the end for anyone who prefers them.

## 1. Apply the schema (D1 Console)

Dashboard → **Storage & Databases → D1 → masrah-saydala → Console**.

Paste and **Execute** the contents of each migration file, in this order:

1. `migrations/0001_initial_schema.sql` — tables, indexes, capacity trigger
2. `migrations/0002_seed_performances.sql` — performances A and B (disabled, priced 0)
3. `migrations/0003_test_mode.sql` — the `test_mode` switch, default off
4. `migrations/0004_customer_name.sql` — booker name columns
5. `migrations/0005_customer_phone.sql` — booker phone columns

Notes:
- If the console rejects the `CREATE TRIGGER` blocks, execute the tables and indexes first,
  then paste each `CREATE TRIGGER … END;` block separately.
- If steps 4/5 report `duplicate column name`, they are already applied — skip them.

## 2. Set capacities, prices, and open the performances

Same Console. These are the **real configured values**:

```sql
UPDATE performances SET capacity=500, price_piasters=5000, enabled=1 WHERE id='A';
UPDATE performances SET capacity=500, price_piasters=5000, enabled=1 WHERE id='B';
```

- Price is in piasters: **50 EGP = 5000**.
- 500 + 500 = 1000 is exactly the event maximum; the trigger only rejects going **over** 1000.
- Database changes take effect **immediately** — no redeploy needed.

To temporarily close one performance: `UPDATE performances SET enabled=0 WHERE id='A';`

Verify:
```sql
SELECT id, doors_open, starts_at, capacity, price_piasters, enabled FROM performances;
```

## 3. Payment + contact details (GitHub web editor)

Open `wrangler.jsonc` on GitHub → **pencil (Edit)** → fill these two values → **Commit changes**
to `main`:

```jsonc
"INSTAPAY_ADDRESS": "01XXXXXXXXX",   // real InstaPay phone, or "name@instapay"
"WHATSAPP_NUMBER": "201XXXXXXXXX",   // international format, digits only, no + or spaces
```

Other available vars:

| Var | Default | Meaning |
|---|---|---|
| `BOOKING_ENABLED` | `"true"` | Global kill-switch. `"false"` closes booking even in test mode. |
| `RESERVATION_TTL_MINUTES` | `"15"` | Length of the temporary hold created at the WhatsApp press. |
| `MAX_TICKETS_PER_BOOKING` | `"10"` | Per-booking quantity limit. |

Vars are runtime configuration, so they apply **after the next deploy**. Committing to `main`
triggers that deploy automatically.

## 4. Poster images (GitHub web upload)

Exact paths and lowercase names:

    public/assets/images/poster.jpg      Performance A — shown in the hero AND on card A
    public/assets/images/poster-b.jpg    Performance B — shown on card B

- Easiest: open the repo on GitHub and press **`.`** to launch **github.dev**, drag both images
  into `public/assets/images/`, then commit from the Source Control panel.
- Or plain web UI: if the folder is missing, use **Add file → Create new file** and type
  `public/assets/images/.gitkeep` (slashes create folders), commit, then open that folder and
  use **Add file → Upload files**.

If an image is missing, the hero falls back to a styled text poster and the card thumbnail
hides itself — the page never shows a broken image. If you use a different extension, update
the two `<img class="perf-poster">` srcs and the hero `data-src` in `public/index.html`.

---

# Booking flow

| Step | Action | Database |
|---|---|---|
| 1 | Choose performance, quantity, name (optional), phone (required) | nothing |
| 2 | Press **متابعة إلى الدفع** | nothing — shows amount + InstaPay address only |
| 3 | Transfer via InstaPay | nothing |
| 4 | Press **سجّل الحجز وأرسل صورة الدفع على واتساب** | **the only write** — atomic hold + ticket numbers |
| 5 | Attach the screenshot manually and send | — |
| 6 | Organizer verifies and sends final tickets on WhatsApp | — |

Browsing, price-checking and even reaching the payment panel create **zero** rows, so nobody can
tie up seats by looking at the price. A hold exists only after step 4.

There is **no countdown in the UI**. The temporary hold is still enforced server-side: each
reservation carries `expires_at`, and the availability query counts only `pending_payment` rows
whose `expires_at > now`. Seats therefore return to the pool automatically once the TTL passes,
with no cron, no cleanup job and no client timer.

WhatsApp click-to-chat cannot detect whether the customer actually pressed **send** inside
WhatsApp, so the press in step 4 is treated as the commitment point. If the customer abandons
afterwards, the hold expires on its own.

Popup handling: step 4 opens a blank tab synchronously inside the click gesture, then navigates
it once the POST resolves. If the browser blocks it, the booking is still recorded and a plain
`<a target="_blank">` (**افتح واتساب وأرفق صورة الدفع**) is revealed — a native anchor click can
never be blocked.

---

# Test mode

Test mode lets you exercise the entire booking flow **before** real payment details exist.
It is stored in the database, so it toggles instantly with no redeploy.

**Turn on** (D1 Console) — this statement is idempotent, so it works whether or not the row
already exists:

```sql
INSERT INTO settings (key, value) VALUES ('test_mode', '1')
ON CONFLICT(key) DO UPDATE SET value = '1';
```

While on:
- Booking opens even with empty `INSTAPAY_ADDRESS` / `WHATSAPP_NUMBER`.
- A striped amber **hazard banner** appears at the top of the page and the header pill reads
  **وضع الاختبار**, so it can never be mistaken for a live sale.
- The payment panel shows **"لا تحوّل أي مبلغ"** and hides the InstaPay row if no address is set.
- If no WhatsApp number is set, the send button is replaced by a **read-only preview of the
  exact WhatsApp message** plus a copy button, so you can verify its contents.
- Reservations, ticket numbering, inventory, expiry and idempotency all behave exactly as live.
- The phone number is still **required** even in test mode — it is the payment-matching key.

**Reset test data** between runs:
```sql
DELETE FROM reservation_tickets;
DELETE FROM reservations;
UPDATE sequences SET next_serial = 1;
```

**Go live** (requires both contact vars filled and deployed):
```sql
UPDATE settings SET value = '0' WHERE key = 'test_mode';
```

`BOOKING_ENABLED="false"` overrides test mode and keeps booking closed.

> If a plain `UPDATE settings …` appears to do nothing, the row was missing — use the
> `INSERT … ON CONFLICT` form above.

---

# Deploy

Cloudflare now steers new projects toward **Workers**, and the Pages creation UI is hidden or
relocated on many accounts. Pages is not deprecated. Both targets run this same code.

## Option A — Cloudflare Pages

Force the Pages Git flow with this direct URL (bypasses the hidden menu):

    https://dash.cloudflare.com/?to=/:account/pages/new/provider/github

Select the repo, branch `main`, then:
- Framework preset: **None**
- Build command: **empty**
- Build output directory: **`public`**

`wrangler.jsonc` keeps `"pages_build_output_dir": "public"` and the root `functions/` directory
is compiled automatically. The file supplies the `DB` binding and vars. Site URL:
`https://<project>.pages.dev`.

## Option B — Cloudflare Workers (static assets)

If you connected the repo as a **Worker** (Workers Builds runs `npx wrangler deploy`), the repo
needs the Worker shape instead:

- `wrangler.jsonc` has `"main": "src/worker.js"` and
  `"assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": ["/api/availability", "/api/reservations"] }`
  instead of `pages_build_output_dir`.
- `src/worker.js` routes `/api/*` to the same handlers in `functions/api/` and serves everything
  else from `env.ASSETS`.
- `name` must match the Worker name shown in the dashboard.
- Site URL: `https://<name>.<your-subdomain>.workers.dev`.

`_headers`, D1 bindings and vars work identically on both targets.

## Database binding

`wrangler.jsonc` → `d1_databases[0].database_id` must be the **real UUID** of `masrah-saydala`.
Find it under D1 → masrah-saydala in the dashboard. The UUID is not a secret and is safe to
commit. Deploying with the literal placeholder fails with
`Error 8000022: Invalid database UUID`.

---

# Reviewing bookings (D1 Console)

Names, phones, ticket numbers, amounts and hold status in one view:

```sql
SELECT t.ticket_number, t.customer_name, t.customer_phone,
       r.id AS booking_ref, r.performance_id, r.total_piasters/100.0 AS egp,
       r.status, datetime(r.expires_at,'unixepoch') AS expires_utc
FROM reservation_tickets t JOIN reservations r ON r.id = t.reservation_id
ORDER BY t.performance_id, t.serial_number;
```

Find a booking by the number shown on an InstaPay transfer (matches local or international form):

```sql
SELECT id, customer_name, customer_phone, quantity, total_piasters/100.0 AS egp, status
FROM reservations
WHERE customer_phone LIKE '%1012345678';
```

Currently active holds only:
```sql
SELECT id, customer_name, customer_phone, performance_id, quantity, total_piasters/100.0 AS egp
FROM reservations
WHERE status='pending_payment' AND expires_at > strftime('%s','now');
```

There is no payment verification in the system. Match the InstaPay transfer to the booking
reference manually, then send the final tickets over WhatsApp.

---

# How inventory correctness works

- Availability = `capacity − SUM(quantity)` of `pending_payment` reservations whose
  `expires_at > now`. Expired holds never count even though their rows remain — **no cron or
  cleanup job is needed for correctness**.
- A booking is one D1 `batch()` (= one transaction), and it happens **only** at the WhatsApp
  press. The reservation row is created by a **conditional `INSERT … SELECT`** that only writes
  when enough unexpired inventory exists at execution time. Ticket allocation and the sequence
  bump are guarded by that row's existence, so a capacity rejection leaves zero side effects.
  D1 serializes writes per database and any failed statement rolls back the whole batch — two
  people can never take the last ticket twice.
- Ticket numbers (`MSD-2026-A-0001`, …) come from a per-performance sequence that advances only
  on success. Expired numbers are never reused; gaps are expected. Capacity is independent of
  numbering.
- Idempotency: the browser generates one UUID per booking attempt and reuses it on retry. A
  repeated key replays the original reservation; a reused key with a different performance or
  quantity is rejected with `IDEMPOTENCY_CONFLICT`. The client retires the key once an attempt
  succeeds or is hard-rejected, so a later booking of the same size cannot replay an expired row.

# API

`GET /api/availability` — public, `no-store`. Returns event info, `booking_open`, config
(including `test_mode`), and per-performance capacity, price, live availability and bookability.
Never returns reservation rows, references, ticket numbers, names or phones.

`POST /api/reservations` — accepts `performance_id`, `quantity`, `idempotency_key`, optional
`customer_name`, and **required** `customer_phone`. Returns the booking reference, individual
ticket numbers, unit/total price and expiry. Errors: `INVALID_BODY`, `INVALID_PERFORMANCE`,
`INVALID_QUANTITY`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_NAME`, `INVALID_PHONE`, `INVALID_JSON`,
`BODY_TOO_LARGE`, `BOOKING_CLOSED`, `PERFORMANCE_DISABLED`, `INSUFFICIENT_CAPACITY`,
`IDEMPOTENCY_CONFLICT`, `DATABASE_ERROR`. Any other method returns `405`.

# Privacy & honesty

- No customer accounts. The optional booker **name** and the required booker **phone** are written
  to the database only at step 4 (the WhatsApp press), never earlier. They are stored with the
  reservation and copied onto each ticket row so organizers can match InstaPay transfers to
  bookings. The name is sanitized (control characters stripped, whitespace collapsed, capped at
  60 characters). The phone is normalized to digits only — Arabic-Indic digits converted,
  separators and `+`/`00` prefixes removed, Egyptian local `01X…` canonicalized to `201X…` — and
  must be 8–15 digits. Neither is returned by any public GET endpoint or shown to other visitors.
  No screenshots or payment credentials are stored.
- On an idempotent replay the originally stored name and phone are kept; resubmitting the same
  key with different details does not overwrite them.
- Clicking WhatsApp **does not** submit or verify payment. The page always states that payment is
  unverified until organizers confirm manually. WhatsApp cannot auto-attach a screenshot —
  the customer attaches it manually.

# WhatsApp message format

    مرحبًا، أريد تأكيد حجز عرض «مكتب حل المشاكل التافهة»
    الاسم: حسن وائل
    رقم الموبايل: 201012345678
    العرض: A — العرض الأول
    فتح الأبواب: 4:30 م — بداية العرض: 5:00 م
    عدد التذاكر: 1
    رقم الحجز: MSD-XZ9FST
    أرقام التذاكر المبدئية:
    MSD-2026-A-0003
    المبلغ: 50 ج.م (تحويل إنستاباي)
    سأرفق صورة الدفع في هذه المحادثة. من فضلكم راجعوا التحويل وأكدوا الحجز.

The name and phone lines are omitted when not supplied. There is no date line.

---

# Visual design

Detective-noir / vintage investigation-office theme, RTL Arabic, CSS-only (no runtime CDN, no
animation library). The page is separated into labeled **scenes**, each with its own reveal,
driven by an `IntersectionObserver` that toggles an `.is-in` class and plain CSS **transitions**
(deliberately not scroll-timeline, so it works in every browser):

| Scene | Reveal |
|---|---|
| 01 Hero / poster | Diagonal curtain wipe + spinning `TOP SECRET` seal on load; poster *develops* from a dark blurred negative like a photograph |
| 02 Case file | Folder lid hinges open in 3D, tab peels, blacked-out lines **de-redact** (bars sweep off), wax seal drops in with a pushpin |
| 03 Booking desk | Header and stepper slide in like a drawer; the two performance cards are **dealt** onto the desk, each tilted the opposite way; fields and ledger cascade after |
| 04 Payment | Excluded from scroll on purpose — **prints** the instant a booking succeeds, and replays on every new booking |
| 05 Procedure | Each step hangs from a pushpin and **swings** into place, one clue at a time |
| 06 Intel | A lamp comes up on the panel (brightness + blur clear) while the lines **decode** left-to-right like a telex |
| End | Lights out: the footer blurs up from darkness like a closing credit |

A fixed **case-index spine** (≥1180px) carries a dashed red-string thread; the dot for the scene
being read glows burgundy/gold and its label slides open. Ambient layers: a rotating searchlight,
drifting archive dust, film grain, and a noir vignette.

Safety properties of the stylesheet:
- The base state of every element is its **final visible** state. Hidden start states exist only
  inside `html.js` + `prefers-reduced-motion: no-preference`, so no-JS or reduced-motion users see
  everything, fully static.
- Scroll reveals are never attached to JS-toggled nodes (`#payment`, `.error`, ticket chips, flow
  step states, header pill), so a booking that succeeds without scrolling still prints normally.
- `@keyframes riseSeq` is declared at top level (not inside a media query) because hero rules
  outside the motion-safe block depend on it.

Dials, if it reads as too busy: delete the four `.case-file::before/::after` fan rules and the
`.stamp` crack; subtract ~`.4s` from the hero delays (they are chained off the curtain); lower
`body::before` opacity `.05 → .025` and slow `html::before` from `22s → 40s` on low-end phones;
delete the `.perf-card::after` sweep.

# Tests (optional, requires a terminal)

    npm install
    npm test

30 tests run against the real SQL and the real request handlers through a D1-compatible shim
over Node's built-in `node:sqlite` (Node ≥ 22.13, no external dependencies). They cover seeding
and times, independent inventories, the 1000-cap trigger, per-attendee numbering, money and
expiry math, idempotent replay and conflicts, concurrent duplicates, input validation, disabled
performances, capacity rejection with zero side effects, last-ticket races at both handler and
raw-SQL level, expiry restoring inventory without a cron, serial non-reuse, batch rollback on
duplicate key and on ticket collision, method guards, name and phone storage/sanitization and
non-disclosure, test mode, public-endpoint privacy, formatting, and the WhatsApp message/URL.

# Local preview (optional, requires a terminal)

    npm run db:migrate:local
    npm run dev

Local development uses a **separate local D1**, so apply the migrations and the performance
configuration there too. Pages target: `wrangler pages dev` → http://localhost:8788.
Worker target: `wrangler dev`.

# CLI equivalents of the GUI steps

    npx wrangler d1 list
    npx wrangler d1 migrations apply masrah-saydala --remote
    npx wrangler d1 execute masrah-saydala --remote --command "UPDATE performances SET capacity=500, price_piasters=5000, enabled=1 WHERE id IN ('A','B');"

---

# Remaining values to supply

| Value | Where | Status |
|---|---|---|
| D1 database UUID | `wrangler.jsonc → d1_databases[0].database_id` | required |
| InstaPay address | `wrangler.jsonc → vars.INSTAPAY_ADDRESS` | **still needed** |
| Organizer WhatsApp number | `wrangler.jsonc → vars.WHATSAPP_NUMBER` | **still needed** |
| Performance capacities | D1 `performances` | done — 500 / 500 |
| Ticket price | D1 `performances` | done — 5000 piasters (50 EGP) |
| Poster images | `public/assets/images/` | supplied by organizer |
| Test mode off | D1 `settings.test_mode = '0'` | do this before announcing |
| Custom domain | hosting dashboard | optional |

# Manual UI checklist

- [ ] Both cards show their poster, date, times, **50 ج.م**, and live availability; RTL is correct.
- [ ] Quantity +/− clamps to availability and the per-booking limit; total updates instantly.
- [ ] Pressing **متابعة إلى الدفع** shows the amount and InstaPay address but leaves
      `SELECT COUNT(*) FROM reservations` at **0**.
- [ ] Pressing **سجّل الحجز وأرسل…** is the only write: 1 reservation + N ticket rows appear,
      and the reference and ticket numbers show up only then.
- [ ] Booking 3 tickets produces 3 individual numbers; the send button is replaced by the
      unblockable **افتح واتساب وأرفق صورة الدفع** anchor.
- [ ] WhatsApp opens prefilled with the exact message format above; screenshot attached manually.
- [ ] InstaPay copy button works; no countdown anywhere on the page.
- [ ] Booker name and phone appear in `reservation_tickets` in the D1 Console.
- [ ] Test-mode hazard banner and header pill visible while testing; both gone after going live.
- [ ] Scenes animate once on scroll with the spine dot tracking; with **Reduce Motion** on,
      everything is visible and completely still.
