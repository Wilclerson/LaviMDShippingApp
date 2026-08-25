#!/usr/bin/env tsx
import './load-env';
/**
 * Seed representative shipments for local UI work and manual QA.
 *
 * Everything goes through the real merge + upsert path, so what you see in the
 * dashboard is produced by the same code that runs in production.
 * NEVER run this against the production database.
 */

import { mergeShipment, quantumViewToUpsFacts } from '../src/lib/shipment-normalizer/merge';
import { upsertShipment } from '../src/lib/database/shipments';
import { closePool, query } from '../src/lib/database/pool';
import type { CarrierEvent, ShipStationShipmentFacts, UpsShipmentFacts } from '../src/lib/types';

const HOUR = 3_600_000;
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);

function ss(over: Partial<ShipStationShipmentFacts> & { trackingNumber: string }): ShipStationShipmentFacts {
  return {
    customerName: 'Unknown',
    companyName: null,
    orderNumber: null,
    shipstationOrderId: null,
    shipstationShipmentId: `se-${over.trackingNumber.slice(-6)}`,
    shipstationLabelId: `se-${over.trackingNumber.slice(-6)}`,
    shipstationStoreId: '55001',
    sourceStore: 'Lavi MD Retail Website',
    shipstationStatus: 'label_purchased',
    carrier: 'UPS',
    service: 'ups_ground',
    labelCreatedAt: ago(3),
    shipDate: now.toISOString().slice(0, 10),
    destinationCity: 'Tampa',
    destinationState: 'FL',
    destinationPostalCode: '33602',
    destinationCountry: 'US',
    voided: false,
    raw: { seeded: true },
    ...over,
  };
}

function scan(at: Date, description: string, code: string, physical: boolean, city = 'Deerfield Beach'): CarrierEvent {
  return {
    occurredAt: at,
    description,
    statusCode: code,
    statusType: physical ? 'I' : 'M',
    locationCity: city,
    locationState: 'FL',
    locationCountry: 'US',
    isPhysicalScan: physical,
    eventSource: 'ups_tracking',
    dedupKey: `${at.toISOString()}|${code}`,
  };
}

function ups(over: Partial<UpsShipmentFacts> & { trackingNumber: string }): UpsShipmentFacts {
  return {
    recipientName: null,
    companyName: null,
    carrier: 'UPS',
    service: 'UPS Ground',
    labelCreatedAt: null,
    shipDate: null,
    destinationCity: null,
    destinationState: null,
    destinationPostalCode: null,
    destinationCountry: null,
    upsStatus: null,
    upsStatusCode: null,
    upsStatusType: null,
    firstCarrierScanAt: null,
    deliveredAt: null,
    latestEvent: null,
    latestEventAt: null,
    exceptionType: null,
    events: [],
    raw: { seeded: true },
    ...over,
  };
}

async function main() {
  await query(`DELETE FROM shipments WHERE tracking_number LIKE '1ZDEMO%'`);
  const opts = { agingThresholdHours: 24 };
  let count = 0;

  const upsert = async (merged: Parameters<typeof upsertShipment>[0]) => {
    await upsertShipment(merged);
    count += 1;
  };

  // 1. Fresh label, no UPS scan — the warehouse still has it.
  await upsert(
    mergeShipment(
      ss({ trackingNumber: '1ZDEMO0000000000001', customerName: 'Maria Alvarez', orderNumber: 'LM-10432', labelCreatedAt: ago(3) }),
      ups({
        trackingNumber: '1ZDEMO0000000000001',
        upsStatus: 'Shipper created a label, UPS has not received the package yet.',
        upsStatusCode: 'MP',
        upsStatusType: 'M',
        latestEvent: 'Shipper created a label, UPS has not received the package yet.',
        latestEventAt: ago(3),
        events: [scan(ago(3), 'Shipper created a label, UPS has not received the package yet.', 'MP', false)],
      }),
      opts,
    ),
  );

  // 2. Label >24h with no scan — the high-priority case.
  await upsert(
    mergeShipment(
      ss({
        trackingNumber: '1ZDEMO0000000000002',
        customerName: 'James Okonkwo',
        orderNumber: 'LM-10388',
        sourceStore: 'Lavi MD Shopify Store',
        labelCreatedAt: ago(41),
        destinationCity: 'Austin',
        destinationState: 'TX',
      }),
      ups({
        trackingNumber: '1ZDEMO0000000000002',
        upsStatus: 'Shipper created a label, UPS has not received the package yet.',
        upsStatusCode: 'MP',
        upsStatusType: 'M',
        latestEvent: 'Shipper created a label, UPS has not received the package yet.',
        latestEventAt: ago(41),
        events: [scan(ago(41), 'Shipper created a label, UPS has not received the package yet.', 'MP', false)],
      }),
      opts,
    ),
  );

  // 3. Label >72h, still nothing — persists across every morning report.
  await upsert(
    mergeShipment(
      ss({
        trackingNumber: '1ZDEMO0000000000003',
        customerName: 'Priya Raman',
        orderNumber: 'LM-10201',
        sourceStore: 'Lavi MD Manual Orders',
        labelCreatedAt: ago(78),
        destinationCity: 'Portland',
        destinationState: 'OR',
      }),
      null,
      opts,
    ),
  );

  // 4. Confirmed shipped — a single origin scan.
  await upsert(
    mergeShipment(
      ss({ trackingNumber: '1ZDEMO0000000000004', customerName: 'Wei Chen', orderNumber: 'LM-10440', labelCreatedAt: ago(20) }),
      ups({
        trackingNumber: '1ZDEMO0000000000004',
        upsStatus: 'Origin Scan',
        upsStatusCode: 'OR',
        upsStatusType: 'I',
        firstCarrierScanAt: ago(14),
        latestEvent: 'Origin Scan',
        latestEventAt: ago(14),
        events: [
          scan(ago(20), 'Shipper created a label, UPS has not received the package yet.', 'MP', false),
          scan(ago(14), 'Origin Scan', 'OR', true),
        ],
      }),
      opts,
    ),
  );

  // 5. In transit — several physical scans.
  await upsert(
    mergeShipment(
      ss({
        trackingNumber: '1ZDEMO0000000000005',
        customerName: 'Sofia Marchetti',
        orderNumber: 'LM-10399',
        sourceStore: 'Lavi MD Shopify Store',
        labelCreatedAt: ago(50),
      }),
      ups({
        trackingNumber: '1ZDEMO0000000000005',
        upsStatus: 'Arrival Scan',
        upsStatusCode: 'AR',
        upsStatusType: 'I',
        firstCarrierScanAt: ago(44),
        latestEvent: 'Arrival Scan',
        latestEventAt: ago(8),
        events: [
          scan(ago(50), 'Shipper created a label, UPS has not received the package yet.', 'MP', false),
          scan(ago(44), 'Origin Scan', 'OR', true),
          scan(ago(30), 'Departure Scan', 'DP', true, 'Jacksonville'),
          scan(ago(8), 'Arrival Scan', 'AR', true, 'Louisville'),
        ],
      }),
      opts,
    ),
  );

  // 6. Delivered.
  await upsert(
    mergeShipment(
      ss({ trackingNumber: '1ZDEMO0000000000006', customerName: 'Aaron Blake', orderNumber: 'LM-10310', labelCreatedAt: ago(96) }),
      ups({
        trackingNumber: '1ZDEMO0000000000006',
        upsStatus: 'Delivered',
        upsStatusCode: 'DL',
        upsStatusType: 'D',
        firstCarrierScanAt: ago(90),
        deliveredAt: ago(6),
        latestEvent: 'Delivered',
        latestEventAt: ago(6),
        events: [
          scan(ago(90), 'Origin Scan', 'OR', true),
          scan(ago(6), 'Delivered', 'DL', true, 'Tampa'),
        ],
      }),
      opts,
    ),
  );

  // 7. Carrier exception.
  await upsert(
    mergeShipment(
      ss({
        trackingNumber: '1ZDEMO0000000000007',
        customerName: 'Nadia Hassan',
        orderNumber: 'LM-10425',
        labelCreatedAt: ago(60),
        destinationCity: 'Denver',
        destinationState: 'CO',
      }),
      ups({
        trackingNumber: '1ZDEMO0000000000007',
        upsStatus: 'Exception',
        upsStatusCode: 'X',
        upsStatusType: 'X',
        firstCarrierScanAt: ago(54),
        exceptionType: 'Address correction required',
        latestEvent: 'Exception: address correction required',
        latestEventAt: ago(10),
        events: [
          scan(ago(54), 'Origin Scan', 'OR', true),
          {
            ...scan(ago(10), 'Exception: address correction required', 'X', true, 'Denver'),
            statusType: 'X',
          },
        ],
      }),
      opts,
    ),
  );

  // 8+9. Danielle's wholesale labels, discovered only through Quantum View.
  await upsert(
    mergeShipment(
      null,
      quantumViewToUpsFacts({
        trackingNumber: '1ZDEMO0000000000008',
        recipientName: 'Danielle Rivera',
        companyName: 'Premier Med Spa',
        service: 'UPS Ground',
        labelCreatedAt: ago(31),
        shipDate: now.toISOString().slice(0, 10),
        destinationCity: 'Scottsdale',
        destinationState: 'AZ',
        destinationPostalCode: '85251',
        destinationCountry: 'US',
        originScanAt: null,
        deliveredAt: null,
        exceptionType: null,
        events: [
          {
            occurredAt: ago(31),
            description: 'Label created (UPS manifest received)',
            statusCode: 'MP',
            statusType: 'M',
            locationCity: null,
            locationState: null,
            locationCountry: null,
            isPhysicalScan: false,
            eventSource: 'ups_quantum_view',
            dedupKey: `qv-manifest|${ago(31).toISOString()}`,
          },
        ],
      }),
      opts,
    ),
  );

  await upsert(
    mergeShipment(
      null,
      quantumViewToUpsFacts({
        trackingNumber: '1ZDEMO0000000000009',
        recipientName: 'Danielle Rivera',
        companyName: 'Glow Aesthetics Group',
        service: 'UPS 2nd Day Air',
        labelCreatedAt: ago(28),
        shipDate: now.toISOString().slice(0, 10),
        destinationCity: 'Reno',
        destinationState: 'NV',
        destinationPostalCode: '89501',
        destinationCountry: 'US',
        originScanAt: ago(22),
        deliveredAt: null,
        exceptionType: null,
        events: [
          {
            occurredAt: ago(28),
            description: 'Label created (UPS manifest received)',
            statusCode: 'MP',
            statusType: 'M',
            locationCity: null,
            locationState: null,
            locationCountry: null,
            isPhysicalScan: false,
            eventSource: 'ups_quantum_view',
            dedupKey: `qv-manifest|${ago(28).toISOString()}`,
          },
          {
            occurredAt: ago(22),
            description: 'Origin Scan — UPS took possession',
            statusCode: 'OR',
            statusType: 'I',
            locationCity: 'Deerfield Beach',
            locationState: 'FL',
            locationCountry: 'US',
            isPhysicalScan: true,
            eventSource: 'ups_quantum_view',
            dedupKey: `qv-origin|${ago(22).toISOString()}`,
          },
        ],
      }),
      opts,
    ),
  );

  // 10. Voided label.
  await upsert(
    mergeShipment(
      ss({
        trackingNumber: '1ZDEMO0000000000010',
        customerName: 'Test Void',
        orderNumber: 'LM-10001',
        labelCreatedAt: ago(50),
        voided: true,
      }),
      null,
      opts,
    ),
  );

  console.log(`Seeded ${count} demo shipments.`);
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
