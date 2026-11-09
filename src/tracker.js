import { mapOrder, shipmentSignature } from './shopify/map.js';
import { keyboard } from './telegram/api.js';
import * as M from './messages.js';

/**
 * Proactive delivery updates for subscribed orders.
 * Triggered by Shopify webhooks (fulfillments/create|update, orders/cancelled, refunds/create)
 * or by polling (`check-shipments`, SHIPMENT_POLL_MINUTES). A message goes out only when the
 * shipment state really changed. Subscriptions end when the order is delivered or cancelled.
 */
export function createTracker({ shopify, store, bot, profile, logger }) {
  async function checkOrder(number) {
    const sub = store.subscription(number);
    if (!sub) return { number, changed: false, reason: 'no subscribers' };
    const order = mapOrder(await shopify.getOrder(sub.orderId));
    if (!order) return { number, changed: false, reason: 'order not found' };
    const sig = shipmentSignature(order);
    if (sig === sub.signature) return { number, changed: false };
    let sent = 0;
    const finished = ['delivered', 'cancelled', 'refunded'].includes(order.status);
    for (const chatId of [...sub.chats]) {
      const kb = keyboard([M.trackingButtons(order, profile), [finished && order.status === 'delivered' ? ['↩️ Return items', `ret:${order.number}`] : ['📦 View order', `ord:${order.number}`]]]);
      try {
        if (await bot.send(chatId, M.shipmentUpdate(order, profile), { reply_markup: kb })) sent++;
      } catch (err) {
        logger.warn(`[tracker] could not notify ${chatId}: ${err.message}`);
      }
    }
    store.setSignature(number, sig);
    store.count('shipment_updates', sent);
    if (finished) for (const chatId of sub.chats) store.unsubscribe(chatId, number);
    return { number, changed: true, status: order.status, notified: sent };
  }

  async function checkAll() {
    const out = [];
    for (const s of store.subscriptions()) {
      try {
        out.push(await checkOrder(s.number));
      } catch (err) {
        out.push({ number: s.number, error: err.message });
      }
    }
    return out;
  }

  /** Shopify webhook payload -> check the affected order if anyone follows it. */
  async function onShopifyWebhook(topic, payload) {
    const orderId = topic.startsWith('orders/') ? payload.id : payload.order_id;
    const sub = store.subscriptions().find((s) => String(s.orderId) === String(orderId));
    if (!sub) return { ignored: true, topic };
    return checkOrder(sub.number);
  }

  return { checkOrder, checkAll, onShopifyWebhook };
}
