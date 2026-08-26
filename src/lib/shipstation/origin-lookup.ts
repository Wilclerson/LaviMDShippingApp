/**
 * "Is this tracking number ShipStation's, or is it genuinely Danielle's?"
 *
 * WHY THIS EXISTS
 * ---------------
 * Quantum View reports every label on the UPS account. The sync used to call a
 * tracking number wholesale whenever it was absent from our own database — but
 * the database only holds the stores listed in SHIPSTATION_STORE_IDS. Any
 * ShipStation shipment from a store outside that list was therefore absent for
 * a completely different reason, and would have been labelled
 * "Wholesale / Danielle" with a null order number despite being an ordinary
 * ShipStation order. On this account that is 44 real shipments in one store.
 *
 * Absence from our database is not absence from ShipStation. This module asks
 * ShipStation directly, across every store, before that judgement is made.
 *
 * Failure policy: an error is not evidence of absence. When ShipStation cannot
 * answer, this throws rather than returning null, so the caller defers the
 * record to the next cycle instead of writing a wrong attribution.
 */

import type { RawLabel, RawShipment } from './client';
import { findLabelByTrackingNumber, getShipment } from './client';
import { toShipStationFacts, type StoreResolver } from './normalize';
import type { ShipStationShipmentFacts } from '../types';

/** The two read-only calls this needs, injectable so it can be tested offline. */
export interface ShipStationOriginClient {
  findLabelByTrackingNumber(trackingNumber: string): Promise<RawLabel | null>;
  getShipment(shipmentId: string): Promise<RawShipment | null>;
}

const liveClient: ShipStationOriginClient = { findLabelByTrackingNumber, getShipment };

/**
 * Resolve a tracking number to ShipStation facts, searching ALL stores.
 *
 * @returns facts when ShipStation owns the tracking number (in any store,
 *          scoped or not), or null when ShipStation positively does not have
 *          it — the only case in which the caller may treat it as wholesale.
 * @throws  when the answer is inconclusive.
 */
export async function lookupShipStationOrigin(
  trackingNumber: string,
  resolver: StoreResolver,
  client: ShipStationOriginClient = liveClient,
): Promise<ShipStationShipmentFacts | null> {
  const label = await client.findLabelByTrackingNumber(trackingNumber);
  if (!label) return null;

  // The shipment record carries customer, order number and store. Its absence
  // is not fatal: the label alone still proves ShipStation origin, which is the
  // question being answered here.
  let shipment: RawShipment | null = null;
  if (label.shipment_id) {
    try {
      shipment = await client.getShipment(label.shipment_id);
    } catch {
      shipment = null;
    }
  }

  const facts = toShipStationFacts(label, shipment, resolver);
  if (!facts) return null;

  // toShipStationFacts normalises the tracking number; make sure we did not
  // resolve to a different package.
  const wanted = trackingNumber.replace(/\s+/g, '').toUpperCase();
  return facts.trackingNumber === wanted ? facts : null;
}
