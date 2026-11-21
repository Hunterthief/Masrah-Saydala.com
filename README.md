# مكتب حل المشاكل التافهة — Masrah Saydala

WhatsApp-first ticket booking page for the Pharmacy Theater Team (Faculty of Pharmacy,
Alexandria). One public purchase page; payment is manual via **InstaPay**, confirmation and
final ticket delivery are manual via **WhatsApp**. No accounts, no admin dashboard, no payment
gateway, no ticket scanning.

- **Event:** مكتب حل المشاكل التافهة — Thursday **3 December 2026**
- **Venue:** Faculty of Pharmacy, New Building, Third Floor
- **Performance A:** doors 4:30 PM, starts 5:00 PM
- **Performance B:** doors 6:30 PM, starts 7:00 PM
- All times are `Africa/Cairo`. Max **1,000** tickets across the whole event.

## Stack

Cloudflare Pages (static `public/`) + Pages Functions (`functions/`) + Cloudflare D1 (SQLite,
binding `DB`). Vanilla HTML/CSS/JS, RTL Arabic, no runtime CDN, no paid services. Money is stored
as integer **piasters** (1 EGP = 100).

## Repository layout

    public/            index.html, css/, js/, assets/, _headers   (static output dir)
    public/assets/images/  poster.jpg, poster-b.jpg               (official posters, committed)
    functions/api/     availability.js, reservations.js            (Pages Functions)
    lib/core.js        shared backend logic + all SQL (used by functions AND tests)
    migrations/        0001_initial_schema.sql, 0002_seed_performances.sql
    test/              booking.test.js  (node --test, D1 shim over node:sqlite)
    wrangler.jsonc     Pages + D1 binding + public vars

## Prerequisites

- Node.js **>= 22.13** (for `npm test` via built-in `node:sqlite`; no other runtime deps).
- A Cloudflare account and the existing D1 database named `masrah-saydala`.
- Wrangler v4 (`npm install` installs it as a dev dependency).

## 1. Install

    npm install
    npx wrangler login

## 2. Point the config at your real D1 database

Find the database ID (do **not** invent it):

    npx wrangler d1 list

Open `wrangler.jsonc` and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with the real UUID of
`masrah-saydala`. (Dashboard -> Storage & Databases -> D1 -> masrah-saydala also shows it.)
If the database does not exist yet: `npx wrangler d1 create masrah-saydala`, then paste the ID.

## 3. Apply migrations

    npm run db:migrate:local     # local dev database
    npm run db:migrate:remote    # production D1

This creates the schema and seeds performances A and B with the correct times, **disabled and
priced 0** until you configure them.

## 4. Configure prices, capacities, enabled status (organizer)

Run in the D1 console (Dashboard -> D1 -> masrah-saydala -> Console) or via
`npx wrangler d1 execute masrah-saydala --remote --command "..."`.

> The numbers below are **EXAMPLES ONLY** — replace with the real values. Combined capacity must
> not exceed 1000 (enforced by a DB trigger). Prices are in piasters: 15000 = 150 EGP.

    UPDATE performances SET capacity = 400, price_piasters = 15000, enabled = 1 WHERE id = 'A';
    UPDATE performances SET capacity = 350, price_piasters = 15000, enabled = 1 WHERE id = 'B';

To temporarily close a performance: `UPDATE performances SET enabled = 0 WHERE id = 'A';`

## 5. Configure InstaPay + WhatsApp (required to open booking)

Edit `vars` in `wrangler.jsonc` (these are public contact values, not secrets):

    "INSTAPAY_ADDRESS": "01XXXXXXXXX",   // or "name@instapay"
    "WHATSAPP_NUMBER": "201XXXXXXXXX",   // international format, digits only, no + or spaces
    "RESERVATION_TTL_MINUTES": "15",     // temporary hold length
    "MAX_TICKETS_PER_BOOKING": "10",     // per-booking limit
    "BOOKING_ENABLED": "true"            // global kill-switch

**Booking stays visibly closed until both `INSTAPAY_ADDRESS` and `WHATSAPP_NUMBER` are set and at
least one performance is configured.** Redeploy after changing vars.

## 6. Official posters

Place your two poster images at these exact paths (lowercase):

    public/assets/images/poster.jpg      Performance A (Doors 4:30 / Show 5:00) — hero + card A
    public/assets/images/poster-b.jpg    Performance B (Doors 6:30 / Show 7:00) — card B

Both are displayed: `poster.jpg` in the hero and on card A, `poster-b.jpg` on card B. If a file is
missing, the hero shows a styled text fallback and the card thumbnail hides itself. If your images
use another extension, update the two `<img class="perf-poster">` srcs and the hero `data-src` in
`public/index.html`. Commit the images.

## 7. Test locally

    npm test          # 23 automated booking/concurrency tests (no network needed)
    npm run dev       # wrangler pages dev -> http://localhost:8788

`wrangler pages dev` reads `wrangler.jsonc` (D1 binding + vars). Apply local migrations first
(step 3). To exercise a full booking locally, set the vars and configure a performance in the
**local** D1 (use `--local` in step 4).

## 8. Deploy (Cloudflare Pages + GitHub)

1. Push this repo to GitHub (`main`).
2. Cloudflare dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git -> select the repo.
3. Build settings: **Framework preset: None**, **Build command: (empty)**, **Build output
   directory: `public`**. The root `functions/` directory is picked up automatically.
4. Because `wrangler.jsonc` contains `pages_build_output_dir`, it becomes the **source of truth**
   for bindings/vars (V2 build system, Wrangler >= 3.45). Make sure the real D1 ID and vars are
   committed before the first deploy. The default `*.pages.dev` domain works; no custom domain is
   assumed.
5. Every push to `main` auto-deploys. Alternatively: `npm run deploy` (Direct Upload).

> If you prefer dashboard-managed bindings instead of the wrangler file, remove
> `pages_build_output_dir` and add the D1 binding `DB` under Pages -> Settings -> Functions.

## Remaining values you must supply

| Value | Where |
|---|---|
| D1 database ID | `wrangler.jsonc -> d1_databases[0].database_id` |
| Performance A capacity & price | D1 `performances` (step 4) |
| Performance B capacity & price | D1 `performances` (step 4) |
| InstaPay address | `wrangler.jsonc -> vars.INSTAPAY_ADDRESS` |
| Organizer WhatsApp number | `wrangler.jsonc -> vars.WHATSAPP_NUMBER` |
| Poster images | `public/assets/images/poster.jpg` + `poster-b.jpg` (step 6) |
| Custom domain (optional) | Pages -> Custom domains |

## How inventory correctness works

- Availability = capacity minus the sum of quantities of `pending_payment` reservations whose
  `expires_at > now`. Expired holds never count, even though their rows remain — **no cron needed**.
- A booking is one D1 `batch()` (= one transaction). The reservation row is created by a
  **conditional INSERT ... SELECT** that only writes when enough unexpired inventory exists at
  execution time. Ticket numbers and the sequence bump are guarded by the reservation's existence,
  so a capacity rejection has zero side effects. D1 serializes writes per database, and any failed
  statement rolls back the whole batch — two people can never take the last ticket twice.
- Ticket numbers (`MSD-2026-A-0001`, ...) come from a per-performance sequence that only advances on
  success. Expired numbers are never reused (gaps are fine). Capacity is independent of numbering.
- Idempotency: the client sends a UUID per booking attempt and reuses it on retry; the server
  replays the original reservation for a repeated key (and rejects a reused key with a different
  payload).

## Privacy & honesty

- No customer accounts, no personal data stored server-side. The optional name is used **only** in
  the WhatsApp message text and never sent to the API. No screenshots or payment credentials are
  stored. Public GET endpoints expose only aggregate availability.
- Clicking WhatsApp **does not** submit or verify payment. The page always states payment is
  unverified until organizers confirm manually. WhatsApp cannot auto-attach the screenshot — the
  customer attaches it manually.

## Manual UI checklist (verify on a phone after deploy)

- [ ] Both cards show their poster, date, times, price, availability; RTL renders correctly.
- [ ] Quantity +/- clamps to available and per-booking limit; total updates instantly.
- [ ] Booking 3 tickets shows 3 individual numbers; InstaPay copy button works.
- [ ] Countdown reaches 0 -> expired notice, seats return to available, WhatsApp disabled.
- [ ] WhatsApp opens prefilled with all details; screenshot must be attached manually.
- [ ] Closed banner shows until configuration is complete.
