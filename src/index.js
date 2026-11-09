import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { createRouterFromEnv } from './ai/index.js';
import { createShopifyClient } from './shopify/client.js';
import { createMockShopify, loadSampleOrders } from './shopify/mock.js';
import { createTelegramApi } from './telegram/api.js';
import { createMockTelegram } from './telegram/mock.js';
import { createStore } from './store.js';
import { createNlu } from './nlu.js';
import { createBot, BOT_COMMANDS } from './bot.js';
import { createTracker } from './tracker.js';
import { createLogger } from './logger.js';

export const EXAMPLES = path.join(PROJECT_ROOT, 'examples');
export const SAMPLE_ORDERS = path.join(EXAMPLES, 'orders.json');

export function loadProfile(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!p.store_name) throw new Error(`${file}: "store_name" is required`);
  return p;
}

/**
 * Build the app. Injectable for tests / demo: tg, shopify, store, aiProviders, demo (mock Shopify
 * with sample orders + mock Telegram), noAi, simulate, fetchImpl, now.
 */
export function createApp({ env = process.env, demo = false, noAi = false, simulate = [], aiProviders, tg, shopify, store, logger = createLogger(), fetchImpl = fetch, now = Date.now } = {}) {
  const config = loadConfig(env);
  const profile = loadProfile(config.businessFile);
  const ai =
    noAi || config.ai.disabled
      ? null
      : createRouterFromEnv(env, {
          fetchImpl,
          simulate,
          providers: aiProviders,
          onEvent: (e) => e.type === 'failure' && logger.warn(`[ai] ${e.target} ${e.kind} -> next model`),
        });

  const shop = shopify || (demo ? createMockShopify({ orders: loadSampleOrders(SAMPLE_ORDERS, now()) }) : config.shopify.configured ? createShopifyClient({ ...config.shopify, fetchImpl }) : null);
  const telegram = tg || (demo ? createMockTelegram() : config.telegram.token ? createTelegramApi(config.telegram.token, { fetchImpl }) : null);
  const db = store !== undefined ? store : createStore(demo ? null : path.join(config.dataDir, 'bot-state.json'), { now });
  const nlu = createNlu({ ai, profile, logger });

  const notifyWebhook = config.notify.webhookUrl
    ? (payload) =>
        fetchImpl(config.notify.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ at: new Date(now()).toISOString(), ...payload }) }).catch((err) =>
          logger.warn(`[alert] webhook failed: ${err.message}`),
        )
    : null;

  const bot = shop && telegram ? createBot({ tg: telegram, shopify: shop, store: db, nlu, profile, config, logger, notifyWebhook, now }) : null;
  const tracker = bot ? createTracker({ shopify: shop, store: db, bot, profile, logger }) : null;
  return { config, profile, ai, shopify: shop, tg: telegram, store: db, nlu, bot, tracker, logger };
}

/** Long polling (no public URL needed). Stops on SIGINT. */
export async function startPolling(app, { once = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { tg, bot, logger } = app;
  const me = await tg.call('getMe');
  await tg.call('deleteWebhook', { drop_pending_updates: false });
  await tg.call('setMyCommands', { commands: BOT_COMMANDS }).catch((err) => logger.warn(`[telegram] setMyCommands: ${err.message}`));
  logger.info(`[telegram] @${me.username} is listening (long polling)`);
  let offset = 0;
  let backoff = 1000;
  let running = true;
  const stop = () => (running = false);
  process.once('SIGINT', stop);
  let pollTimer = null;
  if (app.config.notify.pollMinutes > 0 && !once) {
    pollTimer = setInterval(() => app.tracker.checkAll().catch((e) => logger.warn(`[tracker] ${e.message}`)), app.config.notify.pollMinutes * 60_000);
    pollTimer.unref();
  }
  while (running) {
    try {
      const updates = await tg.call('getUpdates', { offset, timeout: once ? 0 : 25, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: 35_000 });
      backoff = 1000;
      for (const u of updates || []) {
        offset = Math.max(offset, u.update_id + 1);
        bot.enqueue(u);
      }
      if (once) break;
    } catch (err) {
      if (err.status === 401) throw new Error('Telegram rejected the bot token (401). Check TELEGRAM_BOT_TOKEN.');
      if (err.status === 409) logger.error('[telegram] 409: a webhook is set or another instance is polling this token.');
      else logger.warn(`[telegram] polling error: ${err.message}`);
      if (once) throw err;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  if (pollTimer) clearInterval(pollTimer);
  await bot.idle();
  app.store.flush?.();
}

export { createServer } from './server.js';
