# Deployment

Target: **Next.js + PostgreSQL on Vercel**, serving `shipping.lavimd.store`.

---

## Platform choice, and when to move off Vercel

The brief asked for a note if background processing made another platform more
appropriate. It does not, for this workload:

- The sync is a short, bounded HTTP job (a few hundred API calls), not a
  long-running worker. It runs as a cron-invoked route handler.
- Every pass is individually capped (`TRACKING_MAX_LOOKUPS_PER_RUN`, a Quantum
  View page cap, a 5-consecutive-failure abort) so a run finishes inside the
  serverless budget and simply resumes on the next tick.
- Nothing needs to hold state between invocations except PostgreSQL.

**One thing to know:** scheduled functions on Vercel's **Hobby** plan are limited
to one invocation per day, which cannot satisfy "sync every 15–30 minutes".
**A Pro plan is required**, or use an external scheduler (below).

Move off Vercel only if one of these becomes true:

| Trigger | Better fit |
|---|---|
| A sync run genuinely cannot finish in 300s | A container host (Railway, Render, Fly.io) with a persistent worker |
| You want per-minute polling or a real job queue | The same, plus a queue |
| Egress or database latency dominates | Co-locate the app and database in one region |

Nothing in the code is Vercel-specific. The cron endpoints are ordinary
authenticated HTTP routes, so any scheduler can drive them.

---

## 1. Provision PostgreSQL

Any managed Postgres works (Neon, Supabase, RDS, Railway). Prefer a region close
to the app's region.

Get the connection string and set `DATABASE_URL`. Most managed providers need
`?sslmode=require` appended.

## 2. Configure environment variables

Copy every variable from `.env.example` into the host's environment settings.
Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # CRON_SECRET
```

Set `APP_URL=https://shipping.lavimd.store` — it is used for links in the
morning email, so a wrong value produces emails whose buttons go nowhere.

**Never commit `.env`.** It is git-ignored. Credentials are entered in the
hosting dashboard after deployment.

## 3. Deploy

```bash
vercel --prod
```

Or connect the Git repository in the Vercel dashboard and push.

## 4. Run migrations

Migrations are not run automatically on deploy — an accidental redeploy should
never alter the schema. Run them explicitly with production `DATABASE_URL` set:

```bash
DATABASE_URL='postgres://...' npm run migrate
```

The runner is transactional and idempotent: each file applies once, inside a
transaction, and is recorded in `schema_migrations`.

## 5. Create the first administrator

```bash
DATABASE_URL='postgres://...' ADMIN_PASSWORD='<a strong password>' \
  npm run seed:admin -- --email you@lavimd.com --name "Your Name" --role admin
```

Then add the rest of the team from the **Users** page in the app. Passwords are
hashed with scrypt; minimum length is 12 characters.

## 6. DNS for shipping.lavimd.store

In Vercel: **Project → Settings → Domains → Add** `shipping.lavimd.store`.

Then at the DNS provider for `lavimd.store`, add the record Vercel shows:

| Type | Name | Value |
|---|---|---|
| `CNAME` | `shipping` | `cname.vercel-dns.com.` |

Notes:

- Use the exact target Vercel displays — it occasionally differs by account.
- If `lavimd.store` is on Cloudflare, set the record to **DNS only** (grey
  cloud) until Vercel issues the certificate, then re-enable the proxy if you
  want it. Proxying during issuance can stall the ACME challenge.
- Propagation is usually minutes. Verify:

```bash
dig +short shipping.lavimd.store
curl -sI https://shipping.lavimd.store/login | head -1
```

TLS is provisioned automatically once the record resolves.

## 7. Schedule the jobs

`vercel.json` already declares the schedules. Vercel Cron authenticates itself,
but these routes additionally require `CRON_SECRET`, so set the header. In the
Vercel dashboard the cron invocation cannot send a custom header — use the query
form for those, or drive the routes from an external scheduler.

**Cron expressions are UTC.**

| Path | Schedule (UTC) | Purpose |
|---|---|---|
| `/api/cron/sync` | `*/20 * * * *` | Sync every 20 minutes |
| `/api/cron/daily-report` | `0 12 * * *` | 8:00 AM Eastern during EDT |
| `/api/cron/daily-report` | `0 13 * * *` | 8:00 AM Eastern during EST |

America/New_York is UTC-4 in summer and UTC-5 in winter, so the report is
scheduled at **both** 12:00 and 13:00 UTC. The handler checks the actual local
hour and does nothing unless it is the 8 o'clock hour in New York, and a
per-date guard in the database makes a second send for the same day a no-op.
Exactly one email goes out per day, year round.

### Driving the jobs from an external scheduler

Any scheduler that can send an HTTP request works — GitHub Actions, cron-job.org,
a cron entry on an existing server:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://shipping.lavimd.store/api/cron/sync
```

The secret may also be passed as `?secret=...` for schedulers that cannot set
headers. It is compared in constant time.

## 8. Verify the deployment

1. Sign in at <https://shipping.lavimd.store>.
2. Open **System** and confirm every integration shows *Configured*.
3. Press **Run sync now** and watch the pass table fill in.
4. Send a test report to yourself:

```bash
DATABASE_URL='postgres://...' npm run report -- --force --to you@lavimd.com
```

5. Confirm the dashboard shows shipments, and that any wholesale rows display
   `—` in the Order # column and `Wholesale / Danielle` as the source.

---

## Operations

### Monitoring

The **System** page is the operational view: last successful sync per source,
recent errors, and the morning report delivery history. The dashboard shows a
red banner when a sync is failing and a yellow one when it is merely stale
(no success in 90 minutes).

### Backups

Enable point-in-time recovery on the database. This application is the system of
record for "did order X actually leave on Tuesday?" — carrier event history is
append-only and cannot be reconstructed from UPS after Quantum View's 7-day
retention window closes.

### Log hygiene

Logs are structured JSON. The logger redacts the values of every secret
environment variable, any field whose key looks like a credential, and bearer or
basic auth tokens found in free text. Request headers are never logged. Query
parameters are stripped from logged URLs.

### Tuning

| Variable | Default | Effect |
|---|---|---|
| `AGING_LABEL_HOURS` | `24` | Hours before a scan-less label escalates to high priority |
| `SYNC_LOOKBACK_HOURS` | `72` | How far back each sync looks for new/changed labels |
| `TRACKING_MAX_LOOKUPS_PER_RUN` | `250` | UPS tracking calls per run; unscanned shipments are polled first |
| `TRACKING_REFRESH_DELIVERED_DAYS` | `7` | Stop re-polling this long after delivery |

Raise `TRACKING_MAX_LOOKUPS_PER_RUN` if the backlog of unscanned shipments grows
faster than it clears; lower it if runs approach the platform time limit.
