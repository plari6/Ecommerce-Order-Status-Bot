import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createShopifyClient, verifyShopifyWebhook } from '../src/shopify/client.js';
import { createTelegramApi, keyboard, splitMessage, esc } from '../src/telegram/api.js';
import { PROJECT_ROOT } from '../src/config.js';

const res = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] }, text: async () => JSON.stringify(body), json: async () => body });

test('Shopify client: order by name, 429 retry, tag merge on annotate', async () => {
  const seen = [];
  const replies = [
    res(429, { errors: 'Throttled' }, { 'retry-after': '0' }),
    res(200, { orders: [{ id: 1, name: '#1001' }, { id: 2, name: '#10010' }] }),
    res(200, { order: { id: 1, tags: 'vip, wholesale', note: 'old' } }),
    res(200, { order: { id: 1 } }),
  ];
  const shop = createShopifyClient({
    shop: 'demo',
    token: 'shpat_x',
    retryDelayMs: 1,
    fetchImpl: async (url, o) => {
      seen.push({ url, o });
      return replies.shift();
    },
  });
  const o = await shop.findOrderByNumber('#1001');
  assert.equal(o.id, 1);
  assert.match(seen[1].url, /^https:\/\/demo\.myshopify\.com\/admin\/api\/2025-10\/orders\.json\?name=%231001&status=any/);
  assert.equal(seen[1].o.headers['X-Shopify-Access-Token'], 'shpat_x');
  await shop.annotateOrder(1, { addTags: ['return-requested', 'vip'], noteLine: 'Return R1' });
  const put = JSON.parse(seen[3].o.body);
  assert.equal(put.order.tags, 'vip, wholesale, return-requested');
  assert.equal(put.order.note, 'old\nReturn R1');
  const bad = createShopifyClient({ shop: 'd', token: 't', retries: 0, fetchImpl: async () => res(401, { errors: '[API] Invalid API key or access token' }) });
  await assert.rejects(bad.getShop(), /401.*Invalid API key/);
});

test('Shopify webhook signature', () => {
  const body = Buffer.from('{"id":1}');
  const sig = crypto.createHmac('sha256', 's3').update(body).digest('base64');
  assert.equal(verifyShopifyWebhook(body, sig, 's3'), true);
  assert.equal(verifyShopifyWebhook(body, sig, 'other'), false);
  assert.equal(verifyShopifyWebhook(body, undefined, 's3'), false);
});

test('Telegram API: 429 retry, "not modified" ignored, helpers', async () => {
  const replies = [res(429, { ok: false, parameters: { retry_after: 0 } }), res(200, { ok: true, result: { message_id: 5 } }), res(400, { ok: false, description: 'Bad Request: message is not modified' })];
  const api = createTelegramApi('T', { fetchImpl: async () => replies.shift(), wait: async () => {} });
  assert.equal((await api.call('sendMessage', {})).message_id, 5);
  assert.equal(await api.call('editMessageText', {}), true);
  assert.equal(esc('<b>&'), '&lt;b&gt;&amp;');
  assert.deepEqual(keyboard([[['A', 'a'], null], [], [{ text: 'U', url: 'https://x' }]]).inline_keyboard, [[{ text: 'A', callback_data: 'a' }], [{ text: 'U', url: 'https://x' }]]);
  assert.equal(splitMessage('a'.repeat(9000)).length, 3);
});

const cli = (...args) =>
  spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'bin', 'order-bot.js'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ORDER_BOT_SKIP_DOTENV: '1', NO_COLOR: '1', DATA_DIR: path.join(PROJECT_ROOT, 'test', '.tmp-data') },
  });

test('CLI: demo runs end to end with no accounts', () => {
  const r = cli('--no-ai', 'demo');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Return R1002-\w+ approved/);
  assert.match(r.stdout, /Approved by Sam/);
  assert.match(r.stdout, /Update on order #1001/);
});

test('CLI: order --demo and missing-config message', () => {
  const o = cli('--no-ai', 'order', '1003', '--demo');
  assert.equal(o.status, 0, o.stderr);
  assert.match(o.stdout, /Shipment 2/);
  const s = cli('--no-ai', 'start');
  assert.equal(s.status, 2);
  assert.match(s.stderr, /TELEGRAM_BOT_TOKEN/);
});
