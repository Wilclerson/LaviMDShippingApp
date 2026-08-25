import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseTrackingResponse } from '../src/lib/ups/tracking';
import { parseQuantumViewFiles } from '../src/lib/ups/quantum-view';

/**
 * Fixtures modelled on the response shapes documented in
 * UPS-API/api-documentation (Tracking.yaml, QuantumView.yaml).
 */

const LABEL_ONLY_RESPONSE = {
  trackResponse: {
    shipment: [
      {
        inquiryNumber: '1Z999AA10123456784',
        package: [
          {
            trackingNumber: '1Z999AA10123456784',
            currentStatus: {
              code: 'MP',
              description: 'Shipper created a label, UPS has not received the package yet.',
              type: 'M',
            },
            activity: [
              {
                date: '20260824',
                time: '143000',
                gmtDate: '20260824',
                gmtTime: '183000',
                gmtOffset: '-04:00',
                logicalScan: true,
                status: {
                  code: 'MP',
                  description: 'Shipper created a label, UPS has not received the package yet.',
                  type: 'M',
                },
              },
            ],
          },
        ],
      },
    ],
  },
};

const SHIPPED_RESPONSE = {
  trackResponse: {
    shipment: [
      {
        package: [
          {
            trackingNumber: '1Z999AA10123456785',
            currentStatus: { code: 'AR', description: 'Arrival Scan', type: 'I' },
            service: { code: '03', description: 'UPS Ground' },
            activity: [
              {
                date: '20260825',
                time: '040200',
                gmtDate: '20260825',
                gmtTime: '080200',
                gmtOffset: '-04:00',
                logicalScan: false,
                status: { code: 'AR', description: 'Arrival Scan', type: 'I' },
                location: { address: { city: 'Louisville', stateProvince: 'KY', countryCode: 'US' } },
              },
              {
                date: '20260824',
                time: '191500',
                gmtDate: '20260824',
                gmtTime: '231500',
                gmtOffset: '-04:00',
                logicalScan: false,
                status: { code: 'OR', description: 'Origin Scan', type: 'I' },
                location: { address: { city: 'Deerfield Beach', stateProvince: 'FL', countryCode: 'US' } },
              },
              {
                date: '20260824',
                time: '143000',
                gmtDate: '20260824',
                gmtTime: '183000',
                gmtOffset: '-04:00',
                logicalScan: true,
                status: {
                  code: 'MP',
                  description: 'Shipper created a label, UPS has not received the package yet.',
                  type: 'M',
                },
              },
            ],
          },
        ],
      },
    ],
  },
};

describe('UPS tracking parsing', () => {
  test('a label-only response yields NO first carrier scan', () => {
    const facts = parseTrackingResponse('1Z999AA10123456784', LABEL_ONLY_RESPONSE);
    assert.ok(facts);
    assert.equal(facts.firstCarrierScanAt, null);
    assert.equal(facts.deliveredAt, null);
    assert.equal(facts.events.length, 1);
    assert.equal(facts.events[0]!.isPhysicalScan, false);
    // UPS's own manifest timestamp is captured as the label creation time.
    assert.equal(facts.labelCreatedAt?.toISOString(), '2026-08-24T18:30:00.000Z');
  });

  test('the origin scan becomes the first carrier scan, not the manifest', () => {
    const facts = parseTrackingResponse('1Z999AA10123456785', SHIPPED_RESPONSE);
    assert.ok(facts);
    // 20260824 231500 GMT — the Origin Scan, not the 18:30 manifest.
    assert.equal(facts.firstCarrierScanAt?.toISOString(), '2026-08-24T23:15:00.000Z');
    assert.equal(facts.upsStatus, 'Arrival Scan');
    assert.equal(facts.service, 'UPS Ground');
  });

  test('events are stored oldest-first and classified individually', () => {
    const facts = parseTrackingResponse('1Z999AA10123456785', SHIPPED_RESPONSE);
    assert.ok(facts);
    assert.equal(facts.events.length, 3);
    assert.deepEqual(
      facts.events.map((e) => e.isPhysicalScan),
      [false, true, true],
    );
    const times = facts.events.map((e) => e.occurredAt.getTime());
    assert.deepEqual([...times].sort((a, b) => a - b), times, 'events must be chronological');
    assert.equal(facts.latestEvent, 'Arrival Scan');
  });

  test('event dedup keys are stable and unique per scan', () => {
    const a = parseTrackingResponse('1Z999AA10123456785', SHIPPED_RESPONSE)!;
    const b = parseTrackingResponse('1Z999AA10123456785', SHIPPED_RESPONSE)!;
    assert.deepEqual(a.events.map((e) => e.dedupKey), b.events.map((e) => e.dedupKey));
    assert.equal(new Set(a.events.map((e) => e.dedupKey)).size, a.events.length);
  });

  test('a delivered package records deliveredAt', () => {
    const facts = parseTrackingResponse('1Z999AA10123456786', {
      trackResponse: {
        shipment: [
          {
            package: [
              {
                trackingNumber: '1Z999AA10123456786',
                currentStatus: { code: 'DL', description: 'Delivered', type: 'D' },
                activity: [
                  {
                    date: '20260826',
                    time: '101500',
                    gmtDate: '20260826',
                    gmtTime: '141500',
                    logicalScan: false,
                    status: { code: 'DL', description: 'Delivered', type: 'D' },
                    location: { address: { city: 'Austin', stateProvince: 'TX' } },
                  },
                  {
                    date: '20260824',
                    time: '191500',
                    gmtDate: '20260824',
                    gmtTime: '231500',
                    logicalScan: false,
                    status: { code: 'OR', description: 'Origin Scan', type: 'I' },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    assert.ok(facts);
    assert.equal(facts.deliveredAt?.toISOString(), '2026-08-26T14:15:00.000Z');
    assert.equal(facts.firstCarrierScanAt?.toISOString(), '2026-08-24T23:15:00.000Z');
  });

  test('an empty UPS response is null, not a crash', () => {
    assert.equal(parseTrackingResponse('1Z000', {}), null);
    assert.equal(parseTrackingResponse('1Z000', { trackResponse: { shipment: [] } }), null);
  });

  test('multi-piece responses select the matching tracking number', () => {
    const facts = parseTrackingResponse('1ZBBB', {
      trackResponse: {
        shipment: [
          {
            package: [
              { trackingNumber: '1ZAAA', currentStatus: { description: 'Wrong one' }, activity: [] },
              { trackingNumber: '1ZBBB', currentStatus: { description: 'Right one' }, activity: [] },
            ],
          },
        ],
      },
    });
    assert.equal(facts?.upsStatus, 'Right one');
  });
});

describe('Quantum View parsing — Danielle wholesale discovery', () => {
  const MANIFEST_ONLY = {
    Manifest: {
      Shipper: { Name: 'Lavi MD', ShipperNumber: 'A1B2C3' },
      ShipTo: {
        CompanyName: 'Premier Med Spa',
        AttentionName: 'Danielle Rivera',
        Address: { City: 'Scottsdale', StateProvinceCode: 'AZ', PostalCode: '85251', CountryCode: 'US' },
      },
      Service: { Code: '03', Description: 'UPS Ground' },
      PickupDate: '20260825',
      Package: { TrackingNumber: '1ZWHOLE0000000001', Activity: [{ Date: '20260825', Time: '093000' }] },
    },
  };

  test('a manifest-only shipment has a label time but NO origin scan', () => {
    const [shipment] = parseQuantumViewFiles([MANIFEST_ONLY]);
    assert.ok(shipment);
    assert.equal(shipment.trackingNumber, '1ZWHOLE0000000001');
    assert.equal(shipment.companyName, 'Premier Med Spa');
    assert.equal(shipment.recipientName, 'Danielle Rivera');
    assert.equal(shipment.destinationCity, 'Scottsdale');
    assert.equal(shipment.destinationState, 'AZ');
    assert.equal(shipment.labelCreatedAt?.toISOString(), '2026-08-25T09:30:00.000Z');
    assert.equal(shipment.originScanAt, null, 'a manifest is never possession');
    assert.equal(shipment.events.every((e) => !e.isPhysicalScan), true);
  });

  test('an Origin event is definitive physical possession', () => {
    const [shipment] = parseQuantumViewFiles([
      MANIFEST_ONLY,
      {
        Origin: {
          TrackingNumber: '1ZWHOLE0000000001',
          ShipperNumber: 'A1B2C3',
          Date: '20260825',
          Time: '181200',
          ActivityLocation: { Address: { City: 'Deerfield Beach', StateProvinceCode: 'FL' } },
        },
      },
    ]);
    assert.ok(shipment);
    assert.equal(shipment.originScanAt?.toISOString(), '2026-08-25T18:12:00.000Z');
    const physical = shipment.events.filter((e) => e.isPhysicalScan);
    assert.equal(physical.length, 1);
    assert.equal(physical[0]!.statusCode, 'OR');
  });

  test('manifest, origin, exception and delivery collapse into one shipment', () => {
    const shipments = parseQuantumViewFiles([
      MANIFEST_ONLY,
      { Origin: { TrackingNumber: '1ZWHOLE0000000001', Date: '20260825', Time: '181200' } },
      {
        Exception: {
          TrackingNumber: '1ZWHOLE0000000001',
          Date: '20260826',
          Time: '090000',
          StatusDescription: 'Address correction required',
          ReasonDescription: 'Incorrect suite number',
        },
      },
      {
        Delivery: {
          TrackingNumber: '1ZWHOLE0000000001',
          Date: '20260827',
          Time: '141500',
          DeliveryLocation: { City: 'Scottsdale', PoliticalDivision1: 'AZ', SignedForByName: 'D RIVERA' },
        },
      },
    ]);

    assert.equal(shipments.length, 1, 'one tracking number must produce one shipment');
    const shipment = shipments[0]!;
    assert.equal(shipment.originScanAt?.toISOString(), '2026-08-25T18:12:00.000Z');
    assert.equal(shipment.exceptionType, 'Address correction required');
    assert.equal(shipment.deliveredAt?.toISOString(), '2026-08-27T14:15:00.000Z');
    assert.equal(shipment.events.length, 4);
    const times = shipment.events.map((e) => e.occurredAt.getTime());
    assert.deepEqual([...times].sort((a, b) => a - b), times);
  });

  test('multi-package manifests produce one shipment per tracking number', () => {
    const shipments = parseQuantumViewFiles([
      {
        Manifest: {
          ShipTo: { CompanyName: 'Bulk Buyer', Address: { City: 'Reno', StateProvinceCode: 'NV' } },
          PickupDate: '20260825',
          Package: [
            { TrackingNumber: '1ZMULTI0000000001', Activity: [{ Date: '20260825', Time: '100000' }] },
            { TrackingNumber: '1ZMULTI0000000002', Activity: [{ Date: '20260825', Time: '100000' }] },
          ],
        },
      },
    ]);
    assert.equal(shipments.length, 2);
    assert.deepEqual(
      shipments.map((s) => s.trackingNumber).sort(),
      ['1ZMULTI0000000001', '1ZMULTI0000000002'],
    );
  });

  test('v1/v2 style single-object payloads parse the same as v3 arrays', () => {
    const asObject = parseQuantumViewFiles([{ Origin: { TrackingNumber: '1ZSAMEVALUE00001', Date: '20260825', Time: '120000' } }]);
    const asArray = parseQuantumViewFiles([{ Origin: [{ TrackingNumber: '1ZSAMEVALUE00001', Date: '20260825', Time: '120000' }] }]);
    assert.equal(asObject.length, 1);
    assert.equal(asArray.length, 1);
    assert.equal(asObject[0]!.originScanAt?.toISOString(), asArray[0]!.originScanAt?.toISOString());
  });

  test('malformed entries are skipped without throwing', () => {
    const shipments = parseQuantumViewFiles([
      { Manifest: { Package: [{ TrackingNumber: undefined }] } },
      { Origin: { TrackingNumber: '1ZGOOD000000000001', Date: 'garbage', Time: 'nope' } },
      { Delivery: { TrackingNumber: '', Date: '20260825', Time: '120000' } },
    ]);
    assert.equal(shipments.length, 0);
  });

  test('tracking numbers are normalised to uppercase without whitespace', () => {
    const [shipment] = parseQuantumViewFiles([
      { Origin: { TrackingNumber: ' 1zabc 0000 000001 ', Date: '20260825', Time: '120000' } },
    ]);
    assert.equal(shipment?.trackingNumber, '1ZABC0000000001');
  });
});

describe('Quantum View account scoping', () => {
  test('shipments from another shipper number are discarded', async () => {
    const { filterToOwnAccount } = await import('../src/lib/ups/quantum-view');
    const shipments = parseQuantumViewFiles([
      {
        Manifest: {
          Shipper: { ShipperNumber: 'A1B2C3' },
          PickupDate: '20260825',
          Package: { TrackingNumber: '1ZOURS000000000001', Activity: [{ Date: '20260825', Time: '100000' }] },
        },
      },
      {
        Manifest: {
          Shipper: { ShipperNumber: 'ZZZZZZ' },
          PickupDate: '20260825',
          Package: { TrackingNumber: '1ZTHEIRS00000000001', Activity: [{ Date: '20260825', Time: '100000' }] },
        },
      },
    ]);
    assert.equal(shipments.length, 2, 'the parser keeps both');

    const ours = filterToOwnAccount(shipments, 'A1B2C3');
    assert.equal(ours.length, 1);
    assert.equal(ours[0]!.trackingNumber, '1ZOURS000000000001');
  });

  test('shipper number matching ignores case and surrounding whitespace', async () => {
    const { filterToOwnAccount } = await import('../src/lib/ups/quantum-view');
    const shipments = parseQuantumViewFiles([
      {
        Manifest: {
          Shipper: { ShipperNumber: ' a1b2c3 ' },
          PickupDate: '20260825',
          Package: { TrackingNumber: '1ZOURS000000000002', Activity: [{ Date: '20260825', Time: '100000' }] },
        },
      },
    ]);
    assert.equal(filterToOwnAccount(shipments, 'A1B2C3').length, 1);
  });

  test('with no account number configured nothing is filtered out', async () => {
    const { filterToOwnAccount } = await import('../src/lib/ups/quantum-view');
    const shipments = parseQuantumViewFiles([
      {
        Manifest: {
          Shipper: { ShipperNumber: 'ZZZZZZ' },
          PickupDate: '20260825',
          Package: { TrackingNumber: '1ZANY0000000000001', Activity: [{ Date: '20260825', Time: '100000' }] },
        },
      },
    ]);
    assert.equal(filterToOwnAccount(shipments, null).length, 1);
  });

  test('a shipment with no reported shipper number is kept', async () => {
    const { filterToOwnAccount } = await import('../src/lib/ups/quantum-view');
    // An Origin event alone often carries no shipper number. Dropping a real
    // outbound label would be worse than keeping an extra one.
    const shipments = parseQuantumViewFiles([
      { Origin: { TrackingNumber: '1ZNOSHIPPER00000001', Date: '20260825', Time: '120000' } },
    ]);
    assert.equal(shipments[0]!.shipperNumber, null);
    assert.equal(filterToOwnAccount(shipments, 'A1B2C3').length, 1);
  });
});
