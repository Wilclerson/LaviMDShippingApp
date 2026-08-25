# Lavi MD Shipping Audit

Internal shipping audit for Lavi MD. It answers one question, reliably:

> **Did the package actually leave our facility?**

A shipping label existing is not the same as a package shipping. This system
treats those as strictly different things, and never reports a shipment as
shipped without evidence that UPS physically took possession of it.

Production: <https://shipping.lavimd.store>

---

## The core rule

```
LABEL CREATED  ≠  SHIPPED
```

None of these, on their own, make a shipment "Confirmed Shipped":

- a ShipStation label was generated
- a packing slip was printed
- ShipStation marked the order shipped
- UPS says "label created"

The only thing that does is a **physical UPS possession / acceptance / origin
scan**. That rule lives in one file, [`src/lib/ups/codes.ts`](src/lib/ups/codes.ts),
and it fails closed: an event we cannot confidently classify is *not* possession,
so the shipment stays in Needs Attention. Under-reporting costs someone a second
look; over-reporting tells the warehouse a package left when it is still on the
floor.

## Statuses

| Status | Display | Meaning |
|---|---|---|
| `LABEL_CREATED` | ⚠️ Label Created — No Carrier Scan | A label exists, UPS has no possession scan. It may still be in the building. |
| `AGING_LABEL` | 🚨 Label >24 Hours — No UPS Scan | The above, past the threshold. High priority. |
| `SHIPPED` | ✅ Confirmed Shipped | UPS recorded its first physical possession scan. |
| `IN_TRANSIT` | ✅ In Transit | Moving through the UPS network. |
| `DELIVERED` | ✅ Delivered | UPS confirms delivery. |
| `EXCEPTION` | 🚨 Carrier Exception | Exception, failed delivery, return, damage, address issue. |
| `VOIDED` | ◻️ Label Voided | The label was voided; no package is expected. |

Unresolved attention items **persist across days**. A label created Monday that
UPS never scans appears in Tuesday's, Wednesday's and Thursday's report until
UPS scans it or an administrator resolves it.

## Data sources

| Source | Supplies |
|---|---|
| **ShipStation V2** | Ecommerce and manual orders across the three Lavi MD stores: customer, order number, store, tracking number, label creation time. |
| **UPS Tracking** | Authoritative carrier status and the physical possession scan for every UPS tracking number. |
| **UPS Quantum View** | Account-wide activity. This is how labels Danielle creates directly in UPS are discovered — they never touch ShipStation. Its `Origin` event is the cleanest possession signal available. |

### Deduplication

The **tracking number** is the primary matching key.

- ShipStation tracking number == UPS tracking number → **one** shipment record.
  ShipStation is authoritative for customer, order number and store; UPS is
  authoritative for carrier status and scans.
- A tracking number that exists **only** in UPS → `Wholesale / Danielle`, with a
  null order number (rendered as `—`).
- Once ShipStation claims a tracking number it is never downgraded back to
  wholesale.

A `UNIQUE` index on `tracking_number` makes duplicates impossible at the storage
layer, not just in application logic.

## History is never destroyed

`label_created_at` and `first_carrier_scan_at` are write-once. The upsert uses
`LEAST`/`COALESCE` so a thinner-than-usual API response cannot blank a field or
move a timestamp forward, and **database triggers enforce the same rule** as a
backstop:

- `label_created_at` cannot change once set
- `first_carrier_scan_at` can only ever move *earlier* (a late-arriving earlier
  scan), never later and never to null
- `has_physical_scan` cannot go back to false
- carrier events are append-only and idempotent via a dedup key
- shipment records are never deleted; resolution is a flag plus an audit record

This is what makes "did order X leave on Tuesday?" answerable months later.

---

## Getting started

```bash
npm install
cp .env.example .env.local        # then fill in the values
npm run migrate
ADMIN_PASSWORD='<strong password>' npm run seed:admin -- \
  --email you@lavimd.com --name "Your Name" --role admin
npm run dev
```

Requires Node 20+ and PostgreSQL 14+.

### Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Unit tests (add `TEST_DATABASE_URL=…` to include database integration tests) |
| `npm run typecheck` | TypeScript check |
| `npm run migrate` | Apply pending migrations |
| `npm run seed:admin -- --email … --name … --role admin` | Create a user |
| `npm run sync` | Run a full sync from the CLI |
| `npm run sync -- --list-stores` | Print ShipStation store ids |
| `npm run report` | Send the morning report (`--force`, `--to a@b.com`) |
| `npm run report:preview -- --out report.html` | Render the report without sending |

## Architecture

```
src/lib/
  shipstation/        ShipStation V2 client + defensive field normalisation
  ups/                OAuth, Tracking, Quantum View, and the possession rule
    codes.ts            <- the LABEL CREATED != SHIPPED rule lives here
  shipment-normalizer/  status derivation + the merge/dedup engine
  database/           pool, migrations, repository, queries, mutations
  email/              provider abstraction + morning report rendering
  sync/               three-pass orchestration and health reporting
  auth/               scrypt passwords, sessions, RBAC
  http/               retrying fetch with backoff, and route helpers
src/app/              Next.js App Router pages and API routes
db/migrations/        numbered, transactional SQL migrations
```

### Sync

Three passes, each independently recoverable, every 15–30 minutes:

1. **ShipStation** — recently created labels, enriched and filtered to the Lavi
   MD stores.
2. **Quantum View** — UPS account activity; discovers wholesale labels and
   supplies the authoritative origin scan.
3. **UPS Tracking** — refreshes known shipments, polling those with **no
   physical scan first**, because those are the open questions.

A failing pass never blocks the others and never destroys existing data. The
worst case is that a record goes un-refreshed for one cycle, which the dashboard
reports as a stale-sync warning.

### Roles

| | Admin | Fulfillment |
|---|---|---|
| View shipments, search, view tracking | ✅ | ✅ |
| Add notes | ✅ | ✅ |
| Resolve exceptions | ✅ | — |
| Trigger a sync | ✅ | — |
| Manage users | ✅ | — |

Enforced in the UI *and* independently at every API route, so a hidden button is
not the security boundary.

## Security

- All ShipStation and UPS calls are server-side. No credential reaches the browser.
- Sessions are opaque random tokens; only a SHA-256 hash is stored, so a database
  leak yields no usable sessions. Sliding 12-hour expiry, 7-day absolute cap,
  server-side revocation, and invalidation of every session on a password change.
- Passwords are scrypt-hashed with a per-user salt. Login timing does not reveal
  whether an account exists.
- Failed sign-ins are throttled on a rolling 15-minute window, counted per email
  *and* per client IP — the first stops password guessing against one account,
  the second stops one password being sprayed across many. A successful sign-in
  clears the account's lockout, so nobody needs an administrator to let them
  back in.
- All SQL is parameterised. Route input is validated with zod. UUID path
  parameters are checked before reaching the database.
- Cron routes require `CRON_SECRET`, compared in constant time.
- Secrets are redacted from logs by the logger, not by convention.

## Documentation

- [`docs/SHIPSTATION_SETUP.md`](docs/SHIPSTATION_SETUP.md) — V2 API key, store filtering
- [`docs/UPS_SETUP.md`](docs/UPS_SETUP.md) — app creation, **Quantum View subscription**, the possession rule
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — deploy, DNS for `shipping.lavimd.store`, cron schedules, operations
