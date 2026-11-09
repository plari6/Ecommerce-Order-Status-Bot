import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';
import { makeBot, verify } from './helpers.js';

test('subscribed buyer is notified only when the shipment changes; ends on delivery', async () => {
  const { sim, app, shopify } = makeBot();
  await verify(sim, 1, '1001', 'emma.wilson@example.com');
  await sim.press(1, 'Notify me');
  assert.equal(app.store.isSubscribed(1, '1001'), true);
  const before = sim.texts(1).length;
  assert.equal((await app.tracker.checkAll())[0].changed, false);
  assert.equal(sim.texts(1).length, before);
  shopify.setShipmentStatus('1001', 'out_for_delivery');
  const [r] = await app.tracker.checkAll();
  assert.equal(r.notified, 1);
  assert.match(sim.last(1), /Update on order #1001[\s\S]*Out for delivery/);
  shopify.setShipmentStatus('1001', 'delivered');
  await app.tracker.checkAll();
  assert.match(sim.last(1), /Delivered/);
  assert.ok(sim.buttons(1).some((b) => b.text.includes('Return items')));
  assert.equal(app.store.subscriptions().length, 0);
});

test('blocked buyer is unsubscribed', async () => {
  const { sim, app, shopify, tg } = makeBot({ tgOpts: { blocked: [] } });
  await verify(sim, 2, '1001', 'emma.wilson@example.com');
  await sim.press(2, 'Notify me');
  tg.call = ((orig) => async (m, p) => (String(p.chat_id) === '2' && m === 'sendMessage' ? Promise.reject(Object.assign(new Error('blocked'), { status: 403 })) : orig(m, p)))(tg.call.bind(tg));
  shopify.setShipmentStatus('1001', 'out_for_delivery');
  await app.tracker.checkAll();
  assert.equal(app.store.isSubscribed(2, '1001'), false);
});

async function listen(app) {
  const http = createServer(app).listen(0);
  await new Promise((r) => http.once('listening', r));
  return { http, base: `http://127.0.0.1:${http.address().port}` };
}

test('Telegram webhook requires the secret token', async () => {
  const { app, sim } = makeBot({ env: { TELEGRAM_WEBHOOK_SECRET: 'tgsecret' } });
  const { http, base } = await listen(app);
  try {
    const update = { update_id: 1, message: { message_id: 1, chat: { id: 30, type: 'private' }, from: { id: 30, first_name: 'Web' }, text: '/start' } };
    const post = (h) => fetch(`${base}/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(update) });
    assert.equal((await post({ 'x-telegram-bot-api-secret-token': 'nope' })).status, 401);
    assert.equal((await post({ 'x-telegram-bot-api-secret-token': 'tgsecret' })).status, 200);
    await app.bot.idle();
    assert.match(sim.last(30), /order assistant/);
  } finally {
    http.close();
  }
});

test('signed Shopify fulfillment webhook pushes a delivery update', async () => {
  const { app, sim, shopify } = makeBot({ env: { SHOPIFY_WEBHOOK_SECRET: 'shpss' } });
  await verify(sim, 31, '1007', 'amira.haddad@example.com');
  await sim.press(31, 'Notify me');
  shopify.setShipmentStatus('1007', 'delivered');
  const { http, base } = await listen(app);
  try {
    const body = JSON.stringify({ id: 9007, order_id: 5007, shipment_status: 'delivered' });
    const sig = (s) => crypto.createHmac('sha256', s).update(body).digest('base64');
    const post = (h) => fetch(`${base}/webhooks/shopify`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-topic': 'fulfillments/update', ...h }, body });
    assert.equal((await post({ 'x-shopify-hmac-sha256': sig('wrong') })).status, 401);
    assert.equal((await post({ 'x-shopify-hmac-sha256': sig('shpss') })).status, 200);
    for (let i = 0; i < 50 && !/Delivered/.test(sim.last(31)); i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(sim.last(31), /Update on order #1007[\s\S]*Delivered/);
  } finally {
    http.close();
  }
});

test('returns API: list and approve with API key', async () => {
  const { app, sim } = makeBot({ env: { API_KEY: 'k1' } });
  await sim.say(32, '/return 1006 james.taylor@example.com');
  await sim.press(32, 'Continue');
  await sim.press(32, 'damaged');
  await sim.press(32, 'Skip');
  await sim.press(32, 'Skip');
  await sim.press(32, 'Submit');
  const { http, base } = await listen(app);
  try {
    assert.equal((await fetch(`${base}/api/returns`)).status, 401);
    const list = await (await fetch(`${base}/api/returns?status=pending`, { headers: { 'x-api-key': 'k1' } })).json();
    assert.equal(list.returns.length, 1);
    const id = list.returns[0].id;
    const r = await fetch(`${base}/api/returns/${id}/approve`, { method: 'POST', headers: { 'x-api-key': 'k1', 'content-type': 'application/json' }, body: '{"note":"label sent"}' });
    assert.equal(r.status, 200);
    assert.match(sim.last(32), /approved[\s\S]*label sent/);
    assert.equal((await fetch(`${base}/api/returns/${id}/approve`, { method: 'POST', headers: { 'x-api-key': 'k1' } })).status, 409);
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.stats.returns.approved, 1);
  } finally {
    http.close();
  }
});
