import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapOrder, ownsOrder, shipmentSignature } from '../src/shopify/map.js';
import { loadSampleOrders } from '../src/shopify/mock.js';
import { itemEligibility, allowedReasons, approvalDecision, shipmentEta, trackingUrl, returnInstructions } from '../src/policy.js';
import { loadProfile, SAMPLE_ORDERS } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { baseEnv, NOW } from './helpers.js';

const profile = loadProfile(loadConfig(baseEnv()).businessFile);
const orders = Object.fromEntries(loadSampleOrders(SAMPLE_ORDERS, NOW).map((o) => [o.name.slice(1), mapOrder(o)]));
const elig = (n, idx = 0, opts = {}) => itemEligibility(orders[n], orders[n].items[idx], profile, { now: NOW, ...opts });

test('maps Shopify orders to an overall status', () => {
  assert.equal(orders['1001'].status, 'in_transit');
  assert.equal(orders['1002'].status, 'delivered');
  assert.equal(orders['1003'].status, 'partially_delivered');
  assert.equal(orders['1003'].shipments.length, 2);
  assert.equal(orders['1005'].status, 'processing');
  assert.equal(orders['1005'].unshippedItems[0].title, 'Enamel Camp Mug');
  assert.equal(orders['1007'].status, 'out_for_delivery');
  assert.equal(orders['1009'].status, 'cancelled');
  assert.equal(orders['1010'].status, 'attention');
  assert.equal(orders['1002'].items[1].shippedQty, 2);
  assert.ok(orders['1002'].items[0].deliveredAt);
  assert.equal(orders['1009'].items[0].refundedQty, 1);
});

test('ownership check by email or phone', () => {
  const o = orders['1001'];
  assert.equal(ownsOrder(o, 'Emma.Wilson@Example.com'), true);
  assert.equal(ownsOrder(o, 'other@example.com'), false);
  assert.equal(ownsOrder(o, '+1 (415) 555-0101'), true);
  assert.equal(ownsOrder(o, '555 0101'), true); // last digits
  assert.equal(ownsOrder(o, '0101'), false); // too short to prove anything
  assert.equal(ownsOrder(orders['1004'], '12345678'), false); // order without phone
});

test('return eligibility per item', () => {
  assert.equal(elig('1002').ok, true); // delivered 10 days ago
  assert.equal(elig('1002').defectOnly, false);
  assert.equal(elig('1002').maxQty, 1);
  assert.equal(elig('1002', 1).maxQty, 2);
  assert.equal(elig('1002', 1, { pendingQty: 2 }).ok, false); // already requested
  assert.equal(elig('1004').defectOnly, true); // 45 days: only damaged/wrong (60-day window)
  assert.equal(elig('1008', 0).defectOnly, true); // clearance = final sale
  assert.equal(elig('1008', 1).defectOnly, false);
  assert.equal(elig('1001').why, 'not delivered yet');
  assert.equal(elig('1005').why, 'not shipped yet');
  assert.equal(elig('1009').ok, false);
  const old = itemEligibility(orders['1004'], orders['1004'].items[0], profile, { now: NOW + 20 * 864e5 });
  assert.equal(old.ok, false); // past 60 days
  const gift = { ...orders['1002'], items: [{ ...orders['1002'].items[0], giftCard: true }] };
  assert.equal(itemEligibility(gift, gift.items[0], profile, { now: NOW }).defectOnly, true);
});

test('reasons, approval and instructions', () => {
  assert.equal(allowedReasons([{ defectOnly: true }, { defectOnly: false }]).length, 2);
  assert.equal(allowedReasons([{ defectOnly: false }]).length, 6);
  assert.equal(approvalDecision({ reason: 'size', value: 89 }, profile).status, 'approved');
  assert.equal(approvalDecision({ reason: 'size', value: 420 }, profile).status, 'pending');
  assert.equal(approvalDecision({ reason: 'damaged', value: 10 }, profile).status, 'pending');
  assert.equal(approvalDecision({ reason: 'size', value: 1 }, { returns: { auto_approve: false } }).status, 'pending');
  assert.equal(returnInstructions('damaged', profile).free, true);
  assert.match(returnInstructions('size', profile).label, /\$6\.95/);
});

test('ETA, delay and tracking links', () => {
  const late = orders['1003'].shipments[1];
  assert.equal(shipmentEta(late, profile, NOW).delayed, true);
  assert.equal(shipmentEta(orders['1001'].shipments[0], profile, NOW).delayed, false);
  assert.equal(trackingUrl(orders['1001'].shipments[0], profile), 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  assert.equal(trackingUrl({ trackingNumber: 'X1', carrier: 'Unknown Co' }, profile), 'https://northwind-outfitters.example/track?n=X1');
  assert.equal(trackingUrl({ trackingNumber: '', carrier: 'UPS' }, profile), '');
});

test('shipment signature changes with carrier status', () => {
  const a = shipmentSignature(orders['1001']);
  const raw = loadSampleOrders(SAMPLE_ORDERS, NOW).find((o) => o.name === '#1001');
  raw.fulfillments[0].shipment_status = 'delivered';
  assert.notEqual(shipmentSignature(mapOrder(raw)), a);
});
