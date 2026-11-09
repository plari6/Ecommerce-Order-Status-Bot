import crypto from 'node:crypto';

export class ShopifyError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ShopifyError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORDER_FIELDS = 'id,name,email,phone,created_at,processed_at,cancelled_at,financial_status,fulfillment_status,currency,total_price,tags,note,customer,shipping_address,line_items,fulfillments,refunds';

/**
 * Shopify Admin REST client (custom app token, scopes read_orders + write_orders).
 * Retries 429 (Retry-After) and 5xx. Same interface as the in-memory mock in ./mock.js.
 */
export function createShopifyClient({ shop, token, apiVersion = '2025-10', fetchImpl = fetch, retries = 3, retryDelayMs = 1000 }) {
  if (!shop || !token) throw new Error('SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN are required');
  const base = `https://${shop}.myshopify.com/admin/api/${apiVersion}`;

  async function call(method, path, { query, body } = {}, attempt = 0) {
    const url = `${base}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const res = await fetchImpl(url, {
      method,
      headers: { 'X-Shopify-Access-Token': token, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : retryDelayMs * 2 ** attempt);
      return call(method, path, { query, body }, attempt + 1);
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors || data).slice(0, 200);
      throw new ShopifyError(`Shopify ${method} ${path} -> ${res.status}: ${msg}`, { status: res.status, body: data });
    }
    return data;
  }

  return {
    kind: 'shopify',
    shop,
    async getShop() {
      return (await call('GET', '/shop.json')).shop;
    },
    /** Order by its number ("1001" or "#1001"). */
    async findOrderByNumber(number) {
      const n = String(number).replace(/^#/, '').trim();
      const data = await call('GET', '/orders.json', { query: { name: `#${n}`, status: 'any', limit: '5', fields: ORDER_FIELDS } });
      return (data.orders || []).find((o) => String(o.name).replace(/^#/, '') === n || String(o.order_number) === n) || null;
    },
    async getOrder(id) {
      try {
        return (await call('GET', `/orders/${id}.json`, { query: { fields: ORDER_FIELDS } })).order;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
    async listOrdersByEmail(email, limit = 5) {
      return (await call('GET', '/orders.json', { query: { email, status: 'any', limit: String(limit), fields: ORDER_FIELDS } })).orders || [];
    },
    /** Add tags (merging, never replacing) and append a line to the order note. */
    async annotateOrder(id, { addTags = [], noteLine = '' }) {
      const current = await this.getOrder(id);
      if (!current) throw new ShopifyError(`order ${id} not found`, { status: 404 });
      const tags = [...new Set([...String(current.tags || '').split(',').map((t) => t.trim()).filter(Boolean), ...addTags])].join(', ');
      const note = [current.note, noteLine].filter(Boolean).join('\n');
      return (await call('PUT', `/orders/${id}.json`, { body: { order: { id, tags, note } } })).order;
    },
    async listWebhooks() {
      return (await call('GET', '/webhooks.json')).webhooks || [];
    },
    async createWebhook(topic, address) {
      return (await call('POST', '/webhooks.json', { body: { webhook: { topic, address, format: 'json' } } })).webhook;
    },
  };
}

/** Shopify webhook HMAC: base64(HMAC-SHA256(secret, raw body)) in X-Shopify-Hmac-Sha256. */
export function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(hmacHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const WEBHOOK_TOPICS = ['fulfillments/create', 'fulfillments/update', 'orders/cancelled', 'refunds/create'];
