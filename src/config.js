import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load `.env` from the current folder, then the project folder. ORDER_BOT_SKIP_DOTENV=1 disables (tests). */
export function loadDotenv(env = process.env) {
  if (env.ORDER_BOT_SKIP_DOTENV === '1') return [];
  const loaded = [];
  for (const file of [path.resolve(process.cwd(), '.env'), path.join(PROJECT_ROOT, '.env')]) {
    if (!loaded.includes(file) && fs.existsSync(file)) {
      dotenv.config({ path: file, processEnv: env, quiet: true });
      loaded.push(file);
    }
  }
  return loaded;
}

const num = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(PROJECT_ROOT, 'data'));
  return {
    telegram: {
      token: (env.TELEGRAM_BOT_TOKEN || '').trim(),
      webhookSecret: (env.TELEGRAM_WEBHOOK_SECRET || '').trim(),
      staffChatId: (env.STAFF_CHAT_ID || '').trim(),
      adminIds: list(env.ADMIN_USER_IDS), // Telegram user ids allowed to /approve /reject (empty = anyone in the staff chat)
    },
    shopify: {
      shop: (env.SHOPIFY_SHOP || '').trim().replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, ''),
      token: (env.SHOPIFY_ACCESS_TOKEN || '').trim(),
      apiVersion: (env.SHOPIFY_API_VERSION || '2025-10').trim(),
      webhookSecret: (env.SHOPIFY_WEBHOOK_SECRET || '').trim(),
      returnTag: (env.SHOPIFY_RETURN_TAG || 'return-requested').trim(),
      writeBack: bool(env.SHOPIFY_WRITE_BACK, true), // tag + note on the order when a return is requested
      get configured() {
        return Boolean(this.shop && this.token);
      },
    },
    security: {
      maxAttempts: num(env.VERIFY_MAX_ATTEMPTS, 5),
      lockMinutes: num(env.VERIFY_LOCK_MINUTES, 30),
      linkDays: num(env.LINK_DAYS, 30), // how long a verified order stays linked to a chat
    },
    notify: {
      webhookUrl: (env.ALERT_WEBHOOK_URL || '').trim(),
      pollMinutes: num(env.SHIPMENT_POLL_MINUTES, 0),
    },
    businessFile: path.resolve(PROJECT_ROOT, env.BUSINESS_FILE || 'examples/business.json'),
    server: {
      port: num(env.PORT, 3000),
      apiKey: (env.API_KEY || '').trim(),
      publicUrl: (env.PUBLIC_URL || '').trim().replace(/\/$/, ''),
    },
    dataDir,
    ai: { disabled: bool(env.AI_DISABLED) },
  };
}

export function problems(config) {
  const out = [];
  if (!config.telegram.token) out.push('TELEGRAM_BOT_TOKEN is missing (talk to @BotFather, /newbot)');
  if (!config.shopify.configured) out.push('SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN are missing (Shopify admin > Settings > Apps > Develop apps, scopes read_orders, write_orders)');
  return out;
}
