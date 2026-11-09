import { esc } from './telegram/api.js';
import { shipmentEta, processingEta, trackingUrl, reasonLabel } from './policy.js';

/** All buyer-facing text lives here (Telegram HTML), so a client can rebrand or translate it in one place. */

export const fmtDate = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
};
export const money = (n, cur = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
};

const ORDER_STATUS = {
  processing: '🛠 Being prepared',
  in_transit: '🚚 On its way',
  out_for_delivery: '📬 Out for delivery today',
  ready_for_pickup: '🏪 Ready for pickup',
  delivered: '✅ Delivered',
  partially_delivered: '📦 Partly delivered',
  attention: '⚠️ Delivery problem',
  cancelled: '❌ Cancelled',
  refunded: '↩️ Refunded',
};
const SHIP_STATUS = {
  label_created: 'Label created, waiting for carrier pickup',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  attempted_delivery: 'Delivery attempted: the carrier will try again or leave a notice',
  ready_for_pickup: 'Ready for pickup at the carrier location',
  delivered: 'Delivered',
  failure: 'Delivery failed: please contact us',
};

export const statusText = (s) => ORDER_STATUS[s] || s;

export function welcome(name, profile) {
  return `👋 Hi${name ? ` ${esc(name)}` : ''}! I'm the <b>${esc(profile.store_name)}</b> order assistant.\n\nI can:\n• 📦 track your order and shipments\n• ↩️ start a return\n• 🔔 message you when your parcel moves\n\nPick an option below or just type your question, e.g. <i>"where is order #1001?"</i>`;
}

export const askOrderNumber = () => `What's your <b>order number</b>? You'll find it in your confirmation email (e.g. <code>#1001</code>).`;
export const askContact = (number) => `Thanks! To keep your details private, please send the <b>email address</b> (or phone number) used for order <b>#${esc(number)}</b>.`;
export const notFound = (number) => `I couldn't find order <b>#${esc(number)}</b>. Please check the number in your confirmation email and send it again.`;
export const mismatch = (left) => `That email / phone doesn't match this order. Please try again${left > 0 ? ` (${left} attempt${left === 1 ? '' : 's'} left)` : ''}.`;
export const locked = (minutes) => `🔒 Too many attempts. For your security, please try again in ${minutes} minute(s) or tap <b>Talk to a person</b>.`;

export function orderCard(order, profile, now = Date.now()) {
  const lines = [`<b>Order #${esc(order.number)}</b> · ${statusText(order.status)}`, `Placed ${fmtDate(order.createdAt)} · ${money(order.total, order.currency)}${order.city ? ` · to ${esc(order.city)}` : ''}`];
  if (order.status === 'cancelled') {
    lines.push('', 'This order was cancelled. If you were charged, the refund goes back to your original payment method within 5-10 business days.');
    return lines.join('\n');
  }
  order.shipments.forEach((s, i) => {
    const eta = shipmentEta(s, profile, now);
    const items = s.lineItems.map((li) => {
      const it = order.items.find((x) => x.id === li.id);
      return `${li.quantity}× ${esc(it?.title || 'item')}`;
    });
    lines.push('', `<b>${order.shipments.length > 1 ? `Shipment ${i + 1}` : 'Shipment'}</b>${s.carrier ? ` · ${esc(s.carrier)}` : ''}`);
    lines.push(`Status: ${SHIP_STATUS[s.status] || esc(s.status)}${s.status === 'delivered' && s.deliveredAt ? ` on ${fmtDate(s.deliveredAt)}` : ''}`);
    if (s.trackingNumber) lines.push(`Tracking: <code>${esc(s.trackingNumber)}</code>`);
    if (s.status !== 'delivered' && eta.latest) lines.push(eta.delayed ? `⚠️ It's taking longer than expected (was due by ${fmtDate(eta.latest)}). Carriers are sometimes a few days late. If it hasn't moved in 3 days, tap <b>Talk to a person</b> and we'll chase it.` : `Expected: ${eta.earliest ? `${fmtDate(eta.earliest)} – ` : ''}${fmtDate(eta.latest)}`);
    if (items.length) lines.push(`Contains: ${items.join(', ')}`);
  });
  if (order.unshippedItems.length) {
    const eta = processingEta(order, profile);
    lines.push('', `<b>Not shipped yet</b>`, order.unshippedItems.map((i) => `${i.quantity - i.shippedQty - i.refundedQty}× ${esc(i.title)}`).join(', '), eta && Date.parse(eta) > now ? `Usually ships by ${fmtDate(eta)}.` : `We'll message you as soon as it ships.`);
  }
  return lines.join('\n');
}

export function trackingButtons(order, profile) {
  return order.shipments
    .map((s, i) => {
      const url = trackingUrl(s, profile);
      return url ? { text: `🔎 Track${order.shipments.length > 1 ? ` shipment ${i + 1}` : ' on carrier site'}`, url } : null;
    })
    .filter(Boolean);
}

export function itemsPrompt(order, rows) {
  const lines = [`<b>Return from order #${esc(order.number)}</b>`, 'Tap the items you want to return, then <b>Continue</b>.', ''];
  for (const r of rows) lines.push(`${r.elig.ok ? (r.selected ? '☑️' : '⬜️') : '🚫'} ${esc(r.item.title)}${r.item.variant ? ` (${esc(r.item.variant)})` : ''}${r.selected > 1 ? ` ×${r.selected}` : ''} <i>${esc(r.elig.why)}</i>`);
  return lines.join('\n');
}

export const nothingReturnable = (order, rows) =>
  `Nothing in order <b>#${esc(order.number)}</b> can be returned right now:\n${rows.map((r) => `• ${esc(r.item.title)}: ${esc(r.elig.why)}`).join('\n')}\n\nIf something is wrong, tap <b>Talk to a person</b>.`;

export const askReason = (defectOnly) => `Why are you returning ${defectOnly ? 'these items? (Some items can only be returned if they arrived damaged or wrong.)' : 'these items?'}`;
export const askPhoto = () => `Sorry about that! Please send a <b>photo</b> of the item and the damage (or of the wrong item you received). Tap <b>Skip</b> if you can't right now.`;
export const askNote = () => `Anything we should know? Type a short note, or tap <b>Skip</b>.`;

export function returnSummary(order, draft) {
  return [
    `<b>Please confirm your return</b>`,
    `Order #${esc(order.number)}`,
    ...draft.items.map((i) => `• ${i.quantity}× ${esc(i.title)} (${money(i.price * i.quantity, order.currency)})`),
    `Reason: ${esc(reasonLabel(draft.reason))}`,
    draft.note ? `Note: ${esc(draft.note)}` : null,
    draft.photos?.length ? `Photos: ${draft.photos.length}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function returnCreated(ret, instr) {
  const head = ret.status === 'approved' ? `✅ <b>Return ${esc(ret.id)} approved</b>` : `📝 <b>Return request ${esc(ret.id)} received</b>\nOur team will review it within 1 business day and message you here.`;
  const steps =
    ret.status === 'approved'
      ? [instr.label, instr.portalUrl ? `Returns portal: ${esc(instr.portalUrl)}` : null, instr.address ? `Send it to:\n${esc(instr.address)}` : null, `Write <b>${esc(ret.id)}</b> on the parcel.`, `Refund: ${esc(instr.refundTime)}.`]
      : [];
  return [head, ...steps].filter(Boolean).join('\n\n');
}

export function returnDecided(ret, instr, note) {
  if (ret.status === 'rejected') return `Update on return <b>${esc(ret.id)}</b> (order #${esc(ret.orderNumber)}): we're unable to accept this return.${note ? `\nReason: ${esc(note)}` : ''}\n\nReply here or tap <b>Talk to a person</b> if you have questions.`;
  return `${returnCreated({ ...ret, status: 'approved' }, instr)}${note ? `\n\nNote from our team: ${esc(note)}` : ''}`;
}

export function shipmentUpdate(order, profile) {
  return `🔔 <b>Update on order #${esc(order.number)}</b>\n\n${orderCard(order, profile)}`;
}

export function returnsList(returns) {
  if (!returns.length) return 'You have no return requests yet.';
  const icon = { pending: '⏳', approved: '✅', rejected: '❌', received: '📦', refunded: '💸' };
  return `<b>Your returns</b>\n${returns.map((r) => `${icon[r.status] || '•'} ${esc(r.id)} · order #${esc(r.orderNumber)} · ${r.status} · ${r.items.map((i) => `${i.quantity}× ${esc(i.title)}`).join(', ')}`).join('\n')}`;
}

export const helpText = (profile) =>
  `<b>What I can do</b>\n/track – order status and tracking\n/return – start a return\n/orders – your verified orders\n/returns – your return requests\n/human – talk to a person\n/stop – stop delivery notifications\n/cancel – cancel the current step\n\nSupport: ${esc(profile.support_email || '')}${profile.support_hours ? ` (${esc(profile.support_hours)})` : ''}`;

export function staffTicket({ user, chatId, reason, orders, lastMessage }) {
  return `🙋 <b>Customer wants a person</b>\n${esc(user?.name || 'Buyer')}${user?.username ? ` (@${esc(user.username)})` : ''} · chat <code>${esc(chatId)}</code>\nReason: ${esc(reason)}${orders.length ? `\nVerified orders: ${orders.map((o) => `#${esc(o.number)}`).join(', ')}` : ''}${lastMessage ? `\nMessage: "${esc(lastMessage)}"` : ''}\n\n<i>Reply to this message to answer the customer. /close ${esc(chatId)} ends the chat.</i>`;
}

export function staffReturn(ret, order, decision) {
  return `↩️ <b>Return ${esc(ret.id)}</b> · ${ret.status === 'approved' ? '✅ auto-approved' : '⏳ needs review'}\nOrder #${esc(order.number)} · ${esc(order.customerName)} · ${esc(order.email)}\n${ret.items.map((i) => `• ${i.quantity}× ${esc(i.title)} (${money(i.price * i.quantity, order.currency)})`).join('\n')}\nReason: ${esc(reasonLabel(ret.reason))}${ret.note ? `\nNote: "${esc(ret.note)}"` : ''}${ret.photos.length ? `\nPhotos: ${ret.photos.length} (below)` : ''}\nDecision: ${esc(decision.why)}`;
}
