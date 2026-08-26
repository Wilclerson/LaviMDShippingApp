/**
 * UPS tracking status vocabulary and the physical-possession rule.
 *
 * THIS FILE ENCODES THE MOST IMPORTANT BUSINESS RULE IN THE APPLICATION:
 *
 *      A UPS LABEL EXISTING IS NOT THE SAME AS UPS HAVING THE PACKAGE.
 *
 * A shipment only counts as "Confirmed Shipped" once UPS records an actual
 * physical possession / acceptance / origin scan.
 *
 * ---------------------------------------------------------------------------
 * Sources (verified 2026-08-25 against UPS-API/api-documentation on GitHub):
 *
 *  - Tracking.yaml — `GET /api/track/v1/details/{inquiryNumber}`. Each entry in
 *    `package[].activity[]` carries `status.type`, `status.code`,
 *    `status.description`, and `logicalScan`.
 *
 *  - `logicalScan` is documented as: "Indicates whether the shipment event is a
 *    physical or logical event. Valid values: 'true' = logical, 'false' =
 *    physical." A logical event is system-generated bookkeeping (a manifest
 *    upload, a billing record) with no package handling behind it.
 *
 *  - UPSTrackAlertEnhanced.yaml enumerates the status TYPE values:
 *        M  = manifest information          (label created — NOT possession)
 *        MV = manifest void                 (label voided)
 *        I  = in-progress / moving through the UPS network
 *        D  = delivery information (loaded on vehicle, out for delivery, delivered)
 *        X  = exception
 *        U  = update (usually a revised delivery estimate)
 *    UPS additionally returns `P` for pickup activity on many accounts; it is
 *    not in the Alert enum but is possession-positive wherever it appears.
 *
 *  - UPS does not publish a machine-readable enumeration of the 2-character
 *    status CODE values. The code lists below are therefore a *safety net*
 *    layered on top of the type/logicalScan rule, not the primary signal.
 *
 * ---------------------------------------------------------------------------
 * The rule, in order of authority:
 *
 *   1. A Quantum View `Origin` event is definitive physical possession. UPS
 *      only emits it after an origin/pickup scan. Nothing overrides it.
 *   2. Otherwise, a tracking activity is physical possession when ALL hold:
 *        a. status.type is not a manifest type (M / MV) and not 'U'
 *        b. logicalScan is not true
 *        c. status.code is not in PRE_POSSESSION_CODES
 *        d. the description does not match a PRE_POSSESSION_PHRASES pattern
 *   3. Anything that fails the test is treated as "label only". When UPS
 *      gives us an ambiguous signal we deliberately fail CLOSED — the
 *      shipment stays in "Needs Attention" rather than being wrongly reported
 *      as shipped. Under-reporting a shipment is recoverable; telling the
 *      warehouse a package left when it is still on the floor is not.
 */

/** Status types that mean "a label record exists", never possession. */
export const MANIFEST_STATUS_TYPES = new Set(['M', 'MV']);

/** Status types that are informational only and imply nothing about custody. */
export const NON_POSSESSION_STATUS_TYPES = new Set(['U', 'NA', '']);

/** Status types that positively indicate UPS has, or has had, the package. */
export const POSSESSION_STATUS_TYPES = new Set(['I', 'D', 'P', 'X']);

/**
 * 2-character status codes UPS emits before it ever touches the package.
 * These are the codes behind "Shipper created a label, UPS has not received
 * the package yet."
 */
export const PRE_POSSESSION_CODES = new Set([
  'MP', // Manifest Pickup — label created / billing information received
  'M',  // Manifest
  'MV', // Manifest void
  'VP', // Voided pickup
  'OD', // Order data / order processed
]);

/** Codes that unambiguously represent a physical UPS handling scan. */
export const POSSESSION_CODES = new Set([
  'OR', // Origin Scan  <- the canonical "it left our facility" scan
  'PU', // Pickup Scan
  'PK', // Pickup
  'AR', // Arrival Scan
  'DP', // Departure Scan
  'OF', // Out for Delivery
  'OT', // Out for Delivery
  'DS', // Destination Scan
  'IP', // In Progress / package processing
  'DL', // Delivered
  'FS', // Delivered (final scan)
  'KB', // Delivered
]);

/** Codes that mean the package is delivered. */
export const DELIVERED_CODES = new Set(['DL', 'FS', 'KB', 'D']);

/**
 * Description fragments that indicate a label-only, pre-possession event even
 * when the type/code fields are unhelpful. Compared case-insensitively.
 */
export const PRE_POSSESSION_PHRASES = [
  'shipper created a label',
  'shipper created label',
  'label created',
  'order processed: ready for ups',
  'order processed',
  'ready for ups',
  'billing information received',
  'billing information voided',
  'shipment ready for ups',
  'we have received the electronic',
  'awaiting ups', // "Awaiting UPS pickup"
  'drop-off',     // "Ready for drop-off" style pre-tender notices
];

/** Description fragments that indicate the label was voided. */
export const VOIDED_PHRASES = [
  'voided',
  'billing information voided',
  'shipment voided',
  'label cancelled',
  'label canceled',
];

export interface UpsActivityLike {
  statusType?: string | null;
  statusCode?: string | null;
  description?: string | null;
  /** UPS `logicalScan`: true = logical/system event, false = physical scan. */
  logicalScan?: boolean | null;
}

function matchesPhrase(description: string | null | undefined, phrases: string[]): boolean {
  if (!description) return false;
  const lower = description.toLowerCase();
  return phrases.some((p) => lower.includes(p));
}

/** True when the activity describes a label-creation / manifest-only event. */
export function isManifestOnlyActivity(activity: UpsActivityLike): boolean {
  const type = (activity.statusType ?? '').trim().toUpperCase();
  const code = (activity.statusCode ?? '').trim().toUpperCase();

  if (MANIFEST_STATUS_TYPES.has(type)) return true;
  if (PRE_POSSESSION_CODES.has(code)) return true;
  if (matchesPhrase(activity.description, PRE_POSSESSION_PHRASES)) return true;
  return false;
}

/** True when the activity describes a voided label. */
export function isVoidActivity(activity: UpsActivityLike): boolean {
  const type = (activity.statusType ?? '').trim().toUpperCase();
  if (type === 'MV') return true;
  const code = (activity.statusCode ?? '').trim().toUpperCase();
  if (code === 'MV' || code === 'VP') return true;
  return matchesPhrase(activity.description, VOIDED_PHRASES);
}

/**
 * The core predicate: does this activity prove UPS physically has (or had)
 * the package?
 *
 * Fails closed — an activity we cannot confidently classify is NOT possession.
 */
export function isPhysicalPossessionScan(activity: UpsActivityLike): boolean {
  // 1. Manifest and void ALWAYS win. This is the LABEL CREATED != SHIPPED
  //    guarantee and nothing below may override it.
  if (isManifestOnlyActivity(activity)) return false;
  if (isVoidActivity(activity)) return false;

  const type = (activity.statusType ?? '').trim().toUpperCase();
  const code = (activity.statusCode ?? '').trim().toUpperCase();

  // 2. An explicit possession code is trusted over `logicalScan`.
  //
  //    Live data (2026-08-26) shows UPS reports logicalScan on this account in
  //    a way that contradicts its own documentation, in BOTH directions:
  //
  //      M / MP  "Shipper created a label"   logicalScan = false   (43 samples)
  //      I / AR  "Arrived at Facility"       logicalScan = true    (43 samples)
  //      I / DP  "Departed from Facility"    logicalScan = true    (42 samples)
  //      I / OR  "Arrived at Facility"       logicalScan = false
  //
  //    So the flag cannot arbitrate custody on its own. A package cannot arrive
  //    at or depart from a UPS facility unless UPS is holding it, and AR/DP were
  //    always listed in POSSESSION_CODES — the logicalScan veto simply made those
  //    entries unreachable, which is why every shipment stalled at SHIPPED and
  //    IN_TRANSIT was never reached.
  //
  //    Note this cannot promote a label-only shipment: manifest events are
  //    already excluded at step 1, and no manifest code appears here.
  if (POSSESSION_CODES.has(code)) return true;

  // 3. For anything we cannot name, logicalScan is still respected as a veto.
  //    It is only untrusted as *positive* evidence, never as a brake.
  if (activity.logicalScan === true) return false;

  if (POSSESSION_STATUS_TYPES.has(type)) return true;

  // Unknown type AND unknown code: fail closed.
  if (NON_POSSESSION_STATUS_TYPES.has(type)) return false;

  return false;
}

/** True when the activity means the package has been delivered. */
export function isDeliveryActivity(activity: UpsActivityLike): boolean {
  const code = (activity.statusCode ?? '').trim().toUpperCase();
  if (DELIVERED_CODES.has(code)) return true;
  const type = (activity.statusType ?? '').trim().toUpperCase();
  const description = (activity.description ?? '').toLowerCase();
  // Type 'D' covers "out for delivery" too, so require delivery wording.
  return type === 'D' && /\bdeliver(ed|y complete)\b/.test(description);
}

/** True when the activity is a carrier exception. */
export function isExceptionActivity(activity: UpsActivityLike): boolean {
  const type = (activity.statusType ?? '').trim().toUpperCase();
  if (type === 'X') return true;
  const description = (activity.description ?? '').toLowerCase();
  return /\b(exception|returned to shipper|damage|refused|undeliverable|address (issue|correction)|delivery attempt(ed)? failed)\b/.test(
    description,
  );
}
