import crypto from 'node:crypto';
import express from 'express';
import { verifyShopifyWebhook } from './shopify/client.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Webhook mode:
 *   POST /telegram/webhook   Telegram updates (X-Telegram-Bot-Api-Secret-Token checked)
 *   POST /webhooks/shopify   Shopify fulfillment / order webhooks (HMAC checked) -> delivery updates
 *   GET  /health
 *   GET  /api/returns        ?status=pending   (x-api-key)
 *   POST /api/returns/:id/approve | /reject   {note}   (x-api-key) - for a helpdesk or n8n
 *   POST /api/check-shipments                 (x-api-key) - for a cron job
 */
export function createServer(app) {
  const server = express();
  const { config, bot, tracker, store, logger } = app;
  server.disable('x-powered-by');

  server.get('/health', (_req, res) => {
    res.json({
      ok: true,
      telegram: app.tg?.kind || 'not configured',
      shopify: app.shopify?.kind || 'not configured',
      ai: app.ai ? app.ai.status().filter((t) => t.state === 'ready').length + ' model(s) ready' : 'disabled',
      stats: store.stats(),
    });
  });

  server.post('/telegram/webhook', express.json({ limit: '1mb' }), (req, res) => {
    const secret = config.telegram.webhookSecret;
    if (!secret) return res.status(503).json({ error: 'set TELEGRAM_WEBHOOK_SECRET' });
    if (!safeEqual(req.get('x-telegram-bot-api-secret-token') || '', secret)) return res.status(401).end();
    if (!bot) return res.status(503).end();
    res.status(200).end(); // answer fast; Telegram retries slow webhooks
    bot.enqueue(req.body || {});
  });

  // Shopify signs the raw body, so this route reads it unparsed.
  server.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    const secret = config.shopify.webhookSecret;
    if (!secret) return res.status(503).json({ error: 'set SHOPIFY_WEBHOOK_SECRET' });
    if (!verifyShopifyWebhook(req.body, req.get('x-shopify-hmac-sha256'), secret)) return res.status(401).end();
    res.status(200).end();
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return;
    }
    const topic = req.get('x-shopify-topic') || '';
    tracker?.onShopifyWebhook(topic, payload).then(
      (r) => r && !r.ignored && logger.info(`[shopify] ${topic} order #${r.number}: ${r.changed ? `${r.status}, ${r.notified} notified` : 'no change'}`),
      (err) => logger.error(`[shopify] webhook ${topic}: ${err.message}`),
    );
  });

  const auth = (req, res, next) => {
    const key = config.server.apiKey;
    if (!key) return res.status(503).json({ error: 'set API_KEY to use /api' });
    return safeEqual(req.get('x-api-key') || '', key) ? next() : res.status(401).json({ error: 'invalid API key' });
  };
  server.get('/api/returns', auth, (req, res) => res.json({ returns: store.returns({ status: req.query.status, limit: Number(req.query.limit) || 50 }) }));
  server.post('/api/returns/:id/:action(approve|reject)', auth, express.json(), async (req, res) => {
    const r = await bot.decideReturn(req.params.id, req.params.action === 'approve' ? 'approved' : 'rejected', { note: req.body?.note || '', by: req.body?.by || 'api' });
    res.status(r.error ? 409 : 200).json(r);
  });
  server.post('/api/check-shipments', auth, async (_req, res) => res.json({ results: await tracker.checkAll() }));

  server.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return server;
}
