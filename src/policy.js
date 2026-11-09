/**
 * Store rules, decided in code (never by the AI): delivery estimates, delays, tracking links,
 * which items can be returned, and whether a return is approved automatically.
 */

const DAY = 864e5;

export const RETURN_REASONS = [
  ['size', "Doesn't fit"],
  ['changed_mind', 'Changed my mind'],
  ['damaged', 'Arrived damaged / faulty'],
  ['wrong_item', 'Wrong item sent'],
  ['not_as_described', 'Not as described'],
  ['other', 'Other reason'],
];
export const DEFECT_REASONS = ['damaged', 'wrong_item'];
export const reasonLabel = (code) => RETURN_REASONS.find(([c]) => c === code)?.[1] || code;

export function trackingUrl(shipment, profile) {
  if (shipment.trackingUrl) return shipment.trackingUrl;
  if (!shipment.trackingNumber) return '';
  const carriers = profile.carriers || {};
  const key = Object.keys(carriers).find((k) => k.toLowerCase() === String(shipment.carrier).toLowerCase());
  const tpl = carriers[key] || profile.tracking_page;
  return tpl ? tpl.replace('{n}', encodeURIComponent(shipment.trackingNumber)) : '';
}

/** Estimated delivery window and delay flag for one shipment. */
export function shipmentEta(shipment, profile, now = Date.now()) {
  if (shipment.status === 'delivered') return { delayed: false };
  if (shipment.estimatedDelivery) {
    const eta = Date.parse(shipment.estimatedDelivery);
    return { latest: shipment.estimatedDelivery, delayed: Number.isFinite(eta) && now > eta + DAY };
  }
  const transit = profile.shipping?.transit_days || {};
  const key = Object.keys(transit).find((k) => k.toLowerCase() === String(shipment.carrier).toLowerCase());
  const [min, max] = transit[key] || transit.default || [3, 7];
  const shipped = Date.parse(shipment.shippedAt);
  if (!Number.isFinite(shipped)) return { delayed: false };
  return {
    earliest: new Date(shipped + min * DAY).toISOString(),
    latest: new Date(shipped + max * DAY).toISOString(),
    delayed: now > shipped + (max + (profile.shipping?.grace_days ?? 2)) * DAY,
  };
}

/** When an unshipped order should leave the warehouse. */
export function processingEta(order, profile) {
  const days = profile.shipping?.processing_days ?? 2;
  const t = Date.parse(order.createdAt);
  return Number.isFinite(t) ? new Date(t + days * DAY).toISOString() : '';
}

function nonReturnable(order, item, profile) {
  const r = profile.returns || {};
  if (item.giftCard) return 'gift cards cannot be returned';
  const title = `${item.title} ${item.variant}`.toLowerCase();
  if ((r.non_returnable_keywords || []).some((k) => title.includes(k.toLowerCase()))) return 'final-sale item';
  if ((r.non_returnable_sku_prefixes || []).some((p) => item.sku.toUpperCase().startsWith(p.toUpperCase()))) return 'final-sale item';
  if ((r.non_returnable_order_tags || []).some((t) => order.tags.includes(t.toLowerCase()))) return 'final-sale order';
  if (item.properties.some((p) => /personali[sz]|engrav|monogram/i.test(`${p.name} ${p.value}`))) return 'personalised item';
  return null;
}

/**
 * Can this line item be returned? -> { ok, defectOnly, why, maxQty, daysSince }
 * defectOnly = only for damaged / wrong items (final sale, or past the normal window but inside the damaged window).
 * pendingQty = quantity already in an open return request for this item.
 */
export function itemEligibility(order, item, profile, { now = Date.now(), pendingQty = 0 } = {}) {
  const r = profile.returns || {};
  const window = r.window_days ?? 30;
  const defectWindow = Math.max(window, r.damaged_window_days ?? window);
  if (order.cancelled) return { ok: false, why: 'the order was cancelled', maxQty: 0 };
  const maxQty = item.shippedQty - item.refundedQty - pendingQty;
  if (item.shippedQty === 0) return { ok: false, why: 'not shipped yet', maxQty: 0 };
  if (maxQty <= 0) return { ok: false, why: item.refundedQty ? 'already refunded' : 'return already requested', maxQty: 0 };
  if (!item.deliveredAt) return { ok: false, why: 'not delivered yet', maxQty: 0 };
  const daysSince = Math.floor((now - Date.parse(item.deliveredAt)) / DAY);
  if (daysSince > defectWindow) return { ok: false, why: `delivered ${daysSince} days ago (return window ${window} days)`, maxQty: 0, daysSince };
  const blocked = nonReturnable(order, item, profile);
  if (blocked) return { ok: true, defectOnly: true, why: `${blocked}: only if damaged or wrong`, maxQty, daysSince };
  if (daysSince > window) return { ok: true, defectOnly: true, why: `past the ${window}-day window: only if damaged or wrong`, maxQty, daysSince };
  return { ok: true, defectOnly: false, why: `${window - daysSince} day(s) left to return`, maxQty, daysSince };
}

/** Which reasons a selection allows: defect-only items limit the choice to damaged / wrong item. */
export function allowedReasons(eligibilities) {
  return eligibilities.some((e) => e.defectOnly) ? RETURN_REASONS.filter(([c]) => DEFECT_REASONS.includes(c)) : RETURN_REASONS;
}

/** Approve automatically, or leave for staff review. */
export function approvalDecision({ reason, value, photos = 0 }, profile) {
  const r = profile.returns || {};
  if (r.auto_approve === false) return { status: 'pending', why: 'store reviews every return' };
  if (DEFECT_REASONS.includes(reason)) return { status: 'pending', why: photos ? 'damaged / wrong item: staff will check the photos' : 'damaged / wrong item: staff review' };
  const max = Number(r.auto_approve_max_value ?? 200);
  if (value > max) return { status: 'pending', why: `value ${value} is above the auto-approve limit ${max}` };
  return { status: 'approved', why: 'within policy' };
}

/** What the buyer must do next, from the store's return policy. */
export function returnInstructions(reason, profile) {
  const r = profile.returns || {};
  const free = (r.free_return_reasons || DEFECT_REASONS).includes(reason);
  return {
    free,
    label: free ? r.free_label_text || 'We will email you a free prepaid return label within 1 business day.' : r.paid_label_text || `Use our returns portal to print a label${r.return_fee ? ` (${r.return_fee} is deducted from your refund)` : ''}.`,
    portalUrl: free ? '' : r.portal_url || '',
    refundTime: r.refund_time || '5-7 business days after we receive the item',
    address: r.return_address || '',
  };
}
