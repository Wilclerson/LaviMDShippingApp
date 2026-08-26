/**
 * Friendly display names for the Lavi MD ShipStation stores.
 *
 * WHY A STATIC MAP
 * ----------------
 * ShipStation V2 does not carry a store name on shipment or label records, and
 * every store-listing endpoint (/v2/stores, /v2/sales/stores,
 * /v2/connections/stores) returns 404 on this account. The API can tell us
 * WHICH store a shipment came from — never what that store is called. Without
 * this map the dashboard's source column is blank.
 *
 * The ids were established by resolving each store's UI UUID through exact
 * `?shipment_number=` lookups (9 of 9 order numbers matched), and the names
 * were confirmed by the account owner.
 *
 * NOTE ON "Wholesale / Danielle"
 * ------------------------------
 * se-4507974 is Danielle's manual/wholesale flow. Three independently supplied
 * tracking numbers from the tool she uses all resolved to this store, matching
 * all six of its structural traits (no order number, no line items, no
 * warehouse, ship_from "Lavi MD", 16 oz default), and in every case the
 * ShipStation label PRECEDED the UPS manifest by ~3 seconds — proving the
 * labels are purchased through ShipStation rather than created directly in UPS.
 *
 * So "Wholesale / Danielle" here is a DISPLAY NAME only. These shipments are
 * genuinely ShipStation-originated and their internal `source` stays
 * 'shipstation'. The `wholesale_danielle` source value remains reserved for
 * shipments that truly never appear in ShipStation, which only Quantum View can
 * discover.
 */

/** store_id -> the name shown on the dashboard and in the morning report. */
export const STORE_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'se-4492812': 'Lavi MD Manual Orders',
  'se-4492907': 'Lavi MD Retail Website',
  'se-4508646': 'Lavi MD Shopify Store',
  'se-4507974': 'Wholesale / Danielle',
});

/** Display name for a store id, or null when we have no name for it. */
export function storeDisplayName(storeId: string | null | undefined): string | null {
  if (!storeId) return null;
  return STORE_DISPLAY_NAMES[storeId.trim()] ?? null;
}
