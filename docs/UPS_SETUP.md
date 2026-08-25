# UPS API setup

Two UPS APIs are used, and they answer different questions.

| API | Question it answers | Why it is needed |
|---|---|---|
| **Tracking** (`/api/track/v1/details/{tn}`) | "What has happened to tracking number X?" | Verifies whether UPS actually took possession of a package we already know about. |
| **Quantum View** (`/api/quantumview/v3/events`) | "What is happening on our whole UPS account?" | The only way to discover labels Danielle creates directly in UPS — those tracking numbers never reach ShipStation, so there is nothing to look up in the Tracking API. |

Without Quantum View the system still works, but **wholesale / Danielle shipments
will be invisible**. The System page shows a warning when Quantum View is off.

---

## 1. Create the application

1. Sign in at <https://developer.ups.com> with the account that owns the Lavi MD
   UPS shipping account.
2. **Apps → Add Apps**. Choose "I want to integrate UPS technology into my
   business", and select the Lavi MD UPS account number.
3. Add these products to the app:
   - **Tracking**
   - **Quantum View**
4. Save. UPS issues a **Client ID** and **Client Secret**.

Put them in the environment:

```
UPS_CLIENT_ID=...
UPS_CLIENT_SECRET=...
UPS_ACCOUNT_NUMBER=<your 6-character shipper number>
UPS_API_BASE_URL=https://onlinetools.ups.com
```

Use `https://wwwcie.ups.com` to test against the UPS CIE sandbox first.

## 2. Create a Quantum View subscription

**This is the step that is easy to miss.** The Quantum View API returns events
only for subscriptions that exist on the UPS account. A brand-new app with valid
credentials will return an empty result until a subscription exists.

1. Sign in at <https://www.ups.com> with the account credentials.
2. Go to **Quantum View → Administration → Manage Subscriptions** (sometimes
   listed under "Quantum View Manage").
3. Create an **Outbound** subscription for the Lavi MD shipper number.
4. Enable these event types:
   - **Manifest** — a label was created (this is how wholesale labels are found)
   - **Origin** — UPS physically picked the package up (**the possession signal**)
   - **Exception**
   - **Delivery**
5. Note the subscription name if you want to poll only that one:

```
UPS_QUANTUM_VIEW_SUBSCRIPTIONS=LaviMDOutbound
```

Leave `UPS_QUANTUM_VIEW_SUBSCRIPTIONS` **blank** to poll every subscription on
the account — that is the recommended starting point.

## 3. Verify

```bash
npm run sync
```

Look for the `ups_quantum_view` line. `seen=0` on a day when labels were printed
usually means the subscription is missing or has no event types enabled.

---

## How "physically shipped" is decided

This is the most important rule in the application, and it is implemented in
`src/lib/ups/codes.ts`.

A shipment counts as having left the facility only when UPS reports a **physical
possession scan**:

1. **A Quantum View `Origin` event is definitive.** UPS emits it only after an
   origin/pickup scan.
2. Otherwise a Tracking activity counts as possession only when **all** hold:
   - `status.type` is not `M` or `MV` (manifest / manifest void),
   - `logicalScan` is not `true` — UPS documents `true` as a logical/system
     event and `false` as a physical one,
   - `status.code` is not a known pre-possession code (`MP`, `M`, `MV`, `VP`, `OD`),
   - the description does not match a label-created phrase
     ("Shipper created a label…", "Order Processed: Ready for UPS",
     "Billing Information Received", …).
3. **Anything ambiguous fails closed.** An activity we cannot confidently
   classify is *not* possession, so the shipment stays in Needs Attention.

That asymmetry is deliberate. Under-reporting a shipment costs someone a second
look. Over-reporting tells the warehouse a package left when it is still sitting
on the floor — which is the exact failure this system exists to prevent.

None of the following ever produce a "Confirmed Shipped" status on their own:

- a ShipStation label was generated
- a packing slip was printed
- ShipStation marked the order shipped
- UPS says "label created"

### Rate limits and retries

UPS does not publish a single fixed request ceiling; limits are per application.
The client paces tracking calls (~8/second), retries `429` and `5xx` with
exponential backoff plus jitter, honours `Retry-After`, and aborts a run after
five consecutive failures so a UPS outage cannot burn the whole sync window.
`TRACKING_MAX_LOOKUPS_PER_RUN` caps lookups per run; unscanned shipments are
always polled first, and the rest carry over to the next run.

### Data retention

Quantum View retains subscription data for **7 days**. The sync clamps its
lookback window accordingly. Anything older lives in our own database, which is
why the application keeps its own history rather than querying UPS on demand.
