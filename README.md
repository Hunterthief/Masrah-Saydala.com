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
    migrations/                 0001 … 0004 (schema, seed, test mode, booker name)
    test/booking.test.js        28 automated tests (node --test, D1 shim over node:sqlite)
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

Notes:
- If the console rejects the `CREATE TRIGGER` blocks, execute the tables and indexes first,
  then paste each `CREATE TRIGGER … END;` block separately.
- If step 4 reports `duplicate column name`, it is already applied — skip it.

## 2. Set capacities, prices, and open the performances

Same Console. These are the **real configured values**:

```sql
UPDATE performances SET capacity=500, price_piasters=5000, enabled=1 WHERE id='A';
UPDATE performances SET capacity=500, price_piasters=5000, enabled=1 WHERE id='B';
