import { createApp, SAMPLE_ORDERS } from '../src/index.js';
import { createMockShopify, loadSampleOrders } from '../src/shopify/mock.js';
import { createMockTelegram } from '../src/telegram/mock.js';
import { createSimulator } from '../src/simulator.js';
import { silentLogger } from '../src/logger.js';

export const STAFF = '-100777';
export const NOW = Date.parse('2026-11-09T12:00:00Z');
export const baseEnv = (extra = {}) => ({ ORDER_BOT_SKIP_DOTENV: '1', AI_HEDGE_MS: '0', AI_CHAIN: 'fake:one', STAFF_CHAT_ID: STAFF, ...extra });

/** Fake AI provider: fn(req) -> object (JSON-encoded), string or Error. */
export function fakeProvider(fn) {
  const calls = [];
  return {
    configured: true,
    calls,
    async complete(req) {
      calls.push(req);
      const out = fn(req);
      if (out instanceof Error) throw out;
      return { text: typeof out === 'string' ? out : JSON.stringify(out) };
    },
  };
}

export function makeBot({ env = {}, provider, noAi = !provider, shopifyOpts = {}, tgOpts = {}, fetchImpl, now = () => NOW } = {}) {
  const shopify = createMockShopify({ orders: loadSampleOrders(SAMPLE_ORDERS, NOW), ...shopifyOpts });
  const tg = createMockTelegram(tgOpts);
  const app = createApp({ env: baseEnv(env), demo: true, noAi, aiProviders: provider ? { fake: provider } : undefined, shopify, tg, logger: silentLogger, now, ...(fetchImpl ? { fetchImpl } : {}) });
  return { app, shopify, tg, sim: createSimulator(app, { staffChatId: STAFF }) };
}

/** Verify a chat for an order through the normal flow. */
export async function verify(sim, chat, number, contact) {
  await sim.say(chat, `/track ${number}`);
  await sim.say(chat, contact);
}
