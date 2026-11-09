import fs from 'node:fs';

/** "now-5d" / "now+2h" -> ISO date, so the sample orders always look current. */
export function relativeDate(v, now = Date.now()) {
  const m = typeof v === 'string' && v.match(/^now([+-]\d+(?:\.\d+)?)([dh])$/);
  return m ? new Date(now + Number(m[1]) * (m[2] === 'd' ? 864e5 : 36e5)).toISOString() : v;
}

export function loadSampleOrders(file, now = Date.now()) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'), (_k, v) => relativeDate(v, now));
  return Array.isArray(data) ? data : data.orders;
}

/**
 * In-memory Shopify store with the same interface as createShopifyClient.
 * Orders use the real REST shape. Used by `chat`, `demo` and tests.
 */
export function createMockShopify({ orders = [], failOn = {} } = {}) {
  const db = structuredClone(orders);
  const updates = [];
  const webhooks = [];
  const fail = (op) => {
    if (failOn[op]) throw Object.assign(new Error(`mock Shopify ${op} failure`), { status: 500 });
  };
  const byId = (id) => db.find((o) => String(o.id) === String(id));
  return {
    kind: 'mock',
    shop: 'demo-store',
    orders: db,
    updates,
    async getShop() {
      return { name: 'Demo Store', domain: 'demo-store.myshopify.com', currency: 'USD' };
    },
    async findOrderByNumber(number) {
      fail('findOrderByNumber');
      const n = String(number).replace(/^#/, '').trim();
      return structuredClone(db.find((o) => String(o.name).replace(/^#/, '') === n) || null);
    },
    async getOrder(id) {
      fail('getOrder');
      return structuredClone(byId(id) || null);
    },
    async listOrdersByEmail(email) {
      return structuredClone(db.filter((o) => String(o.email).toLowerCase() === String(email).toLowerCase()));
    },
    async annotateOrder(id, { addTags = [], noteLine = '' }) {
      fail('annotateOrder');
      const o = byId(id);
      if (!o) throw Object.assign(new Error('not found'), { status: 404 });
      o.tags = [...new Set([...String(o.tags || '').split(',').map((t) => t.trim()).filter(Boolean), ...addTags])].join(', ');
      o.note = [o.note, noteLine].filter(Boolean).join('\n');
      updates.push({ id, addTags, noteLine });
      return structuredClone(o);
    },
    async listWebhooks() {
      return webhooks;
    },
    async createWebhook(topic, address) {
      const w = { id: webhooks.length + 1, topic, address };
      webhooks.push(w);
      return w;
    },
    /** Demo helper: move a shipment to a new carrier status (like a carrier scan would). */
    setShipmentStatus(number, status, index = 0) {
      const o = db.find((x) => String(x.name).replace(/^#/, '') === String(number));
      const f = o?.fulfillments?.[index];
      if (!f) throw new Error(`order ${number} has no shipment ${index}`);
      f.shipment_status = status;
      f.updated_at = new Date().toISOString();
      return structuredClone(o);
    },
  };
}
