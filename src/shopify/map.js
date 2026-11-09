/**
 * Raw Shopify REST order -> the shape the bot works with:
 * { id, number, email, phone, customerName, createdAt, status, cancelled, financialStatus, total, currency,
 *   city, country, tags[], items[], shipments[], unshippedItems[] }
 * status: cancelled | refunded | delivered | partially_delivered | out_for_delivery | in_transit | attention | processing
 */

const SHIP_STATUS = {
  label_printed: 'label_created',
  label_purchased: 'label_created',
  confirmed: 'in_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  attempted_delivery: 'attempted_delivery',
  ready_for_pickup: 'ready_for_pickup',
  picked_up: 'delivered',
  delivered: 'delivered',
  failure: 'failure',
};

const normEmail = (e) => String(e || '').trim().toLowerCase();
const digits = (p) => String(p || '').replace(/\D/g, '');

export function mapOrder(o) {
  if (!o) return null;
  const refunded = {};
  for (const r of o.refunds || []) for (const rl of r.refund_line_items || []) refunded[rl.line_item_id] = (refunded[rl.line_item_id] || 0) + Number(rl.quantity || 0);

  const shipments = (o.fulfillments || [])
    .filter((f) => f.status !== 'cancelled' && f.status !== 'error' && f.status !== 'failure')
    .map((f) => {
      const status = SHIP_STATUS[f.shipment_status] || (f.status === 'success' ? 'in_transit' : 'label_created');
      return {
        id: f.id,
        status,
        carrier: f.tracking_company || '',
        trackingNumber: f.tracking_number || (f.tracking_numbers || [])[0] || '',
        trackingUrl: f.tracking_url || (f.tracking_urls || [])[0] || '',
        shippedAt: f.created_at || '',
        updatedAt: f.updated_at || f.created_at || '',
        deliveredAt: status === 'delivered' ? f.updated_at || f.created_at : '',
        estimatedDelivery: f.estimated_delivery_at || '',
        lineItems: (f.line_items || []).map((li) => ({ id: li.id, quantity: Number(li.quantity || 0) })),
      };
    });

  const shippedQty = {};
  const deliveredAt = {};
  for (const s of shipments)
    for (const li of s.lineItems) {
      shippedQty[li.id] = (shippedQty[li.id] || 0) + li.quantity;
      if (s.deliveredAt && (!deliveredAt[li.id] || s.deliveredAt > deliveredAt[li.id])) deliveredAt[li.id] = s.deliveredAt;
    }

  const items = (o.line_items || []).map((li) => ({
    id: li.id,
    title: li.title || li.name || 'Item',
    variant: li.variant_title || '',
    sku: li.sku || '',
    quantity: Number(li.quantity || 0),
    price: Number(li.price || 0),
    giftCard: Boolean(li.gift_card),
    shippedQty: Math.min(Number(li.quantity || 0), shippedQty[li.id] || 0),
    refundedQty: refunded[li.id] || 0,
    deliveredAt: deliveredAt[li.id] || '',
    properties: li.properties || [],
  }));

  const unshippedItems = items.filter((i) => i.quantity - i.shippedQty - i.refundedQty > 0 && !i.giftCard);
  return {
    id: o.id,
    number: String(o.name || o.order_number || o.id).replace(/^#/, ''),
    email: normEmail(o.email || o.customer?.email),
    phone: digits(o.phone || o.customer?.phone || o.shipping_address?.phone),
    customerName: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || o.shipping_address?.name || '',
    firstName: o.customer?.first_name || String(o.shipping_address?.name || '').split(' ')[0] || '',
    createdAt: o.processed_at || o.created_at || '',
    cancelled: Boolean(o.cancelled_at),
    financialStatus: o.financial_status || '',
    total: Number(o.total_price || 0),
    currency: o.currency || 'USD',
    city: o.shipping_address?.city || '',
    country: o.shipping_address?.country || '',
    tags: String(o.tags || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
    items,
    shipments,
    unshippedItems,
    status: overallStatus(o, shipments, unshippedItems),
  };
}

function overallStatus(o, shipments, unshipped) {
  if (o.cancelled_at) return 'cancelled';
  if (o.financial_status === 'refunded') return 'refunded';
  if (!shipments.length) return 'processing';
  const st = shipments.map((s) => s.status);
  if (st.some((s) => s === 'failure' || s === 'attempted_delivery')) return 'attention';
  if (st.every((s) => s === 'delivered')) return unshipped.length ? 'partially_delivered' : 'delivered';
  if (st.some((s) => s === 'delivered')) return 'partially_delivered';
  if (st.some((s) => s === 'out_for_delivery')) return 'out_for_delivery';
  if (st.some((s) => s === 'ready_for_pickup')) return 'ready_for_pickup';
  return 'in_transit';
}

/**
 * Does this buyer own the order? Email (case-insensitive) or the last 6+ digits of the phone.
 * Used before showing anything about an order.
 */
export function ownsOrder(order, contact) {
  const c = String(contact || '').trim();
  if (!order || !c) return false;
  if (c.includes('@')) return Boolean(order.email) && normEmail(c) === order.email;
  const d = digits(c);
  return d.length >= 6 && order.phone.length >= 6 && order.phone.endsWith(d.slice(-Math.min(d.length, 10)));
}

/** Short fingerprint of shipment state, used to detect changes worth a notification. */
export const shipmentSignature = (order) =>
  `${order.status}|${order.shipments
    .map((s) => `${s.id}:${s.status}:${s.trackingNumber}`)
    .sort()
    .join(',')}`;
