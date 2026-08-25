# ShipStation API setup

## Which API version

This application uses the **ShipStation API V2** at `https://api.shipstation.com`.

The older V1 API (`ssapi.shipstation.com`, authenticated with an API *key and
secret* pair sent as HTTP Basic) is deprecated. V1 keys will not work here — the
`SHIPSTATION_API_KEY` variable expects a **V2 key**, sent as an `API-Key`
request header.

## 1. Get a V2 API key

1. Sign in to ShipStation.
2. **Settings → Account → API Settings**.
3. Under **V2 API Keys**, create a key (only one V2 key is active at a time).
4. Copy it into the environment:

```
SHIPSTATION_API_KEY=...
```

The key is used only server-side. It is never sent to the browser and is
redacted from every log line.

## 2. Restrict to the Lavi MD stores

The sync should only ingest these stores:

- Lavi MD Manual Orders
- Lavi MD Retail Website
- Lavi MD Shopify Store

Two ways to configure that, and both can be used together.

**By store id (preferred — exact and fast).** List the stores:

```bash
npm run sync -- --list-stores
```

Then set:

```
SHIPSTATION_STORE_IDS=12345,12346,12347
```

**By store name (fallback).** Already set in `.env.example`:

```
SHIPSTATION_STORE_NAMES=Lavi MD Manual Orders,Lavi MD Retail Website,Lavi MD Shopify Store
```

Name matching is case-insensitive. If a store is renamed in ShipStation, update
this list, or switch to ids which do not change.

> If **both** lists are empty the sync ingests **every** store and logs a
> warning. The System page shows the same warning.

## 3. Verify

```bash
npm run sync
```

The `shipstation` line reports how many labels were seen, how many were skipped
as out of scope, and how many pages were read.

---

## What the sync reads

`GET /v2/labels` is the primary feed, because **label creation is the event this
application audits**. Each label supplies the tracking number and the creation
timestamp. Each label's `shipment_id` is then resolved through
`GET /v2/shipments/{id}` to attach the customer, order number and store, and
those lookups are cached per run since several labels can share a shipment.

Fields are read through a list of candidate keys rather than one hard-coded
name (`order_number` / `external_order_id` / `shipment_number` all appear in the
wild depending on which integration created the order). A field ShipStation
renames therefore degrades to a null value instead of breaking the audit.

If a shipment lookup fails, the label is still recorded — the tracking number
and label timestamp are the audit-critical facts, and the customer/order details
are backfilled on a later sync.

## Rate limits

ShipStation V2 allows roughly **200 requests per minute** and returns
`X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining` and `X-Rate-Limit-Reset` headers,
plus `Retry-After` on a `429`.

The client paces itself to about 3 requests/second, slows down further when the
remaining budget drops below 20, and retries `429`/`5xx` with exponential
backoff and jitter. The goal is that this audit never becomes the reason
ShipStation starts rate-limiting the warehouse's own label printing.

## Non-UPS shipments

Labels for other carriers are still recorded, but they will never gain a UPS
possession scan and so are not expected to reach "Confirmed Shipped" via UPS.
The tracking refresh only polls shipments whose carrier is UPS.
