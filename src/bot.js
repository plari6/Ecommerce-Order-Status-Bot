import { randomBytes } from 'node:crypto';
import { esc, keyboard, splitMessage } from './telegram/api.js';
import { mapOrder, ownsOrder, shipmentSignature } from './shopify/map.js';
import { extractOrderNumber, extractEmail, extractPhone } from './nlu.js';
import { itemEligibility, allowedReasons, approvalDecision, returnInstructions, reasonLabel, DEFECT_REASONS } from './policy.js';
import * as M from './messages.js';

const MAIN_MENU = keyboard([
  [
    ['📦 Track my order', 'menu:track'],
    ['↩️ Return an item', 'menu:return'],
  ],
  [
    ['🧾 My orders', 'menu:orders'],
    ['🙋 Talk to a person', 'human'],
  ],
]);
const CANCEL = keyboard([[['✖️ Cancel', 'cancel']]]);

/**
 * Conversation engine. Channel = Telegram Bot API (`tg.call`), data = Shopify (`shopify`).
 * Every order view needs the buyer to prove ownership once (order number + email/phone);
 * the order is then linked to that chat for LINK_DAYS days.
 */
export function createBot({ tg, shopify, store, nlu, profile, config, logger, notifyWebhook, now = Date.now }) {
  const staffChat = config.telegram.staffChatId;
  const sec = config.security;
  const queues = new Map();

  // ---------- sending
  async function send(chatId, text, extra = {}) {
    let last;
    for (const part of splitMessage(text)) {
      try {
        last = await tg.call('sendMessage', { chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
      } catch (err) {
        if (err.status === 403) {
          logger.info(`[bot] chat ${chatId} blocked the bot; removing its notifications`);
          store.unsubscribeAll(chatId);
          return null;
        }
        throw err;
      }
    }
    return last;
  }
  const edit = (chatId, messageId, text, extra = {}) => tg.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  /** Edit the message a button belongs to, or send a new one. */
  const show = (chatId, msgId, text, extra) => (msgId ? edit(chatId, msgId, text, extra).catch(() => send(chatId, text, extra)) : send(chatId, text, extra));

  async function loadOrder(chatId, number) {
    const link = store.linkedOrders(chatId, sec.linkDays).find((o) => o.number === String(number));
    const raw = link ? await shopify.getOrder(link.id) : await shopify.findOrderByNumber(number);
    return mapOrder(raw);
  }

  // ---------- verification
  function lockedFor(chatId) {
    const a = store.attemptState(chatId);
    return a.lockedUntil > now() ? Math.ceil((a.lockedUntil - now()) / 60_000) : 0;
  }

  async function startVerify(chatId, next, number = null, contact = null) {
    if (number && store.isLinked(chatId, number, sec.linkDays)) return proceed(chatId, next, number);
    const mins = lockedFor(chatId);
    if (mins) return send(chatId, M.locked(mins), { reply_markup: keyboard([[['🙋 Talk to a person', 'human']]]) });
    if (number && contact) return verify(chatId, { next, number }, contact);
    store.setSession(chatId, { flow: 'verify', next, number, step: number ? 'contact' : 'order' });
    return send(chatId, number ? M.askContact(number) : M.askOrderNumber(), { reply_markup: CANCEL });
  }

  async function failAttempt(chatId) {
    const a = store.recordFailedAttempt(chatId, { max: sec.maxAttempts, lockMinutes: sec.lockMinutes });
    store.count('verify_failed');
    if (a.lockedUntil > now()) {
      store.clearSession(chatId);
      await send(chatId, M.locked(sec.lockMinutes), { reply_markup: keyboard([[['🙋 Talk to a person', 'human']]]) });
      return true;
    }
    return sec.maxAttempts - a.count;
  }

  async function verify(chatId, sess, contact) {
    const raw = await shopify.findOrderByNumber(sess.number);
    if (!raw) {
      const left = await failAttempt(chatId);
      if (left === true) return;
      store.setSession(chatId, { flow: 'verify', next: sess.next, step: 'order' });
      return send(chatId, M.notFound(sess.number), { reply_markup: CANCEL });
    }
    const order = mapOrder(raw);
    if (!ownsOrder(order, contact)) {
      const left = await failAttempt(chatId);
      if (left === true) return;
      store.setSession(chatId, { flow: 'verify', next: sess.next, number: sess.number, step: 'contact' });
      return send(chatId, M.mismatch(left), { reply_markup: CANCEL });
    }
    store.resetAttempts(chatId);
    store.linkOrder(chatId, order);
    store.clearSession(chatId);
    store.count('verified');
    return proceed(chatId, sess.next, order.number, order);
  }

  const proceed = (chatId, next, number, order) => (next === 'return' ? startReturn(chatId, number, null, order) : showOrder(chatId, number, null, order));

  // ---------- tracking
  async function showOrder(chatId, number, msgId = null, preloaded = null) {
    const order = preloaded || (await loadOrder(chatId, number));
    if (!order) return send(chatId, M.notFound(number));
    store.count('track');
    const subscribed = store.isSubscribed(chatId, order.number);
    const done = ['delivered', 'cancelled', 'refunded'].includes(order.status);
    const canReturn = order.items.some((i) => i.deliveredAt);
    const kb = keyboard([
      M.trackingButtons(order, profile),
      [['🔄 Refresh', `ref:${order.number}`], done ? null : subscribed ? ['🔕 Stop updates', `uns:${order.number}`] : ['🔔 Notify me', `sub:${order.number}`]],
      [canReturn ? ['↩️ Return items', `ret:${order.number}`] : null, ['🙋 Talk to a person', 'human']],
    ]);
    return show(chatId, msgId, M.orderCard(order, profile, now()), { reply_markup: kb });
  }

  async function listOrders(chatId) {
    const linked = store.linkedOrders(chatId, sec.linkDays);
    if (!linked.length) return startVerify(chatId, 'track');
    if (linked.length === 1) return showOrder(chatId, linked[0].number);
    return send(chatId, 'Which order?', { reply_markup: keyboard([...linked.slice(0, 8).map((o) => [[`Order #${o.number}`, `ord:${o.number}`]]), [['➕ Another order', 'menu:new']]]) });
  }

  // ---------- returns
  function returnRows(order, sel = {}) {
    return order.items.map((item, idx) => ({ idx, item, elig: itemEligibility(order, item, profile, { now: now(), pendingQty: store.pendingQty(order.number, item.id) }), selected: sel[item.id] || 0 }));
  }

  function itemsKeyboard(rows) {
    const btns = rows.filter((r) => r.elig.ok).map((r) => [[`${r.selected ? '☑️' : '⬜️'} ${r.item.title.slice(0, 28)}${r.selected ? ` ×${r.selected}` : ''}`, `ri:${r.idx}`]]);
    return keyboard([...btns, [rows.some((r) => r.selected) ? ['Continue ➡️', 'rgo'] : null, ['✖️ Cancel', 'cancel']]]);
  }

  async function startReturn(chatId, number, msgId = null, preloaded = null) {
    const order = preloaded || (await loadOrder(chatId, number));
    if (!order) return send(chatId, M.notFound(number));
    const rows = returnRows(order);
    if (!rows.some((r) => r.elig.ok)) {
      store.clearSession(chatId);
      return show(chatId, msgId, M.nothingReturnable(order, rows), { reply_markup: keyboard([[['🙋 Talk to a person', 'human']]]) });
    }
    // Pre-select the only returnable item.
    const ok = rows.filter((r) => r.elig.ok);
    const sel = ok.length === 1 && ok[0].elig.maxQty === 1 ? { [ok[0].item.id]: 1 } : {};
    store.setSession(chatId, { flow: 'return', step: 'items', number: order.number, orderId: order.id, sel, photos: [] });
    store.count('return_started');
    const fresh = returnRows(order, sel);
    return show(chatId, msgId, M.itemsPrompt(order, fresh), { reply_markup: itemsKeyboard(fresh) });
  }

  async function returnStep(chatId, sess, msgId) {
    const order = await loadOrder(chatId, sess.number);
    const rows = returnRows(order, sess.sel);
    const chosen = rows.filter((r) => r.selected);
    if (sess.step === 'items') return show(chatId, msgId, M.itemsPrompt(order, rows), { reply_markup: itemsKeyboard(rows) });
    if (sess.step === 'reason') {
      const reasons = allowedReasons(chosen.map((r) => r.elig));
      return show(chatId, msgId, M.askReason(chosen.some((r) => r.elig.defectOnly)), { reply_markup: keyboard([...reasons.map(([c, l]) => [[l, `rr:${c}`]]), [['✖️ Cancel', 'cancel']]]) });
    }
    if (sess.step === 'photo') return show(chatId, msgId, `${M.askPhoto()}${sess.photos.length ? `\n\n📷 ${sess.photos.length} photo(s) received.` : ''}`, { reply_markup: keyboard([[[sess.photos.length ? 'Done ✅' : 'Skip', 'rskip']], [['✖️ Cancel', 'cancel']]]) });
    if (sess.step === 'note') return show(chatId, msgId, M.askNote(), { reply_markup: keyboard([[['Skip', 'rskip']], [['✖️ Cancel', 'cancel']]]) });
    if (sess.step === 'confirm') {
      const draft = { items: chosen.map((r) => ({ id: r.item.id, title: r.item.title, quantity: r.selected, price: r.item.price })), reason: sess.reason, note: sess.note, photos: sess.photos };
      return show(chatId, msgId, M.returnSummary(order, draft), { reply_markup: keyboard([[['✅ Submit return', 'rok']], [['✖️ Cancel', 'cancel']]]) });
    }
  }

  async function submitReturn(chatId, sess, msgId) {
    const order = await loadOrder(chatId, sess.number);
    const rows = returnRows(order, sess.sel).filter((r) => r.selected);
    // Re-check eligibility at submit time (another return may have been filed meanwhile).
    const bad = rows.find((r) => !r.elig.ok || r.selected > r.elig.maxQty || (r.elig.defectOnly && !DEFECT_REASONS.includes(sess.reason)));
    if (!rows.length || bad) {
      store.clearSession(chatId);
      return show(chatId, msgId, `Sorry, ${bad ? esc(bad.item.title) : 'that selection'} can no longer be returned (${esc(bad?.elig.why || 'nothing selected')}). Please start again with /return.`);
    }
    const items = rows.map((r) => ({ id: r.item.id, title: r.item.title, quantity: r.selected, price: r.item.price }));
    const value = items.reduce((n, i) => n + i.price * i.quantity, 0);
    const decision = approvalDecision({ reason: sess.reason, value, photos: sess.photos.length }, profile);
    const ret = store.addReturn({
      id: `R${order.number}-${randomBytes(3).toString('hex').toUpperCase()}`,
      chatId: String(chatId),
      orderNumber: order.number,
      orderId: order.id,
      email: order.email,
      items,
      value,
      currency: order.currency,
      reason: sess.reason,
      note: sess.note || '',
      photos: sess.photos,
      status: decision.status,
      decisionWhy: decision.why,
      createdAt: new Date(now()).toISOString(),
    });
    store.clearSession(chatId);
    store.count(`return_${decision.status}`);
    const instr = returnInstructions(ret.reason, profile);
    await show(chatId, msgId, M.returnCreated(ret, instr), { reply_markup: keyboard([[['📦 Back to order', `ord:${order.number}`]]]) });

    await syncShopify(ret, `Return ${ret.id} requested via Telegram (${decision.status}): ${items.map((i) => `${i.quantity}x ${i.title}`).join(', ')}; reason: ${reasonLabel(ret.reason)}${ret.note ? `; note: ${ret.note}` : ''}`, [config.shopify.returnTag, decision.status === 'approved' ? 'return-approved' : 'return-pending']);
    await notifyStaffReturn(ret, order, decision);
    notifyWebhook?.({ type: 'return_requested', return: ret, order: { number: order.number, email: order.email, customer: order.customerName } });
  }

  async function syncShopify(ret, noteLine, tags) {
    if (!config.shopify.writeBack) return;
    try {
      await shopify.annotateOrder(ret.orderId, { addTags: tags, noteLine });
      store.updateReturn(ret.id, { shopifySynced: true });
    } catch (err) {
      store.updateReturn(ret.id, { shopifySynced: false, shopifyError: err.message });
      logger.error(`[shopify] could not tag order ${ret.orderNumber}: ${err.message}`);
    }
  }

  async function notifyStaffReturn(ret, order, decision) {
    if (!staffChat) return;
    try {
      const kb = ret.status === 'pending' ? keyboard([[['✅ Approve', `sa:${ret.id}`], ['❌ Reject', `sr:${ret.id}`]]]) : undefined;
      await send(staffChat, M.staffReturn(ret, order, decision), kb ? { reply_markup: kb } : {});
      for (const p of ret.photos) await tg.call('sendPhoto', { chat_id: staffChat, photo: p, caption: `${ret.id}` });
    } catch (err) {
      logger.error(`[staff] notify failed: ${err.message}`);
    }
  }

  /** Staff approve / reject. Also used by the CLI and HTTP API. */
  async function decideReturn(id, status, { note = '', by = 'staff' } = {}) {
    const ret = store.findReturn(id);
    if (!ret) return { error: `return ${id} not found` };
    if (ret.status !== 'pending') return { error: `return ${ret.id} is already ${ret.status}`, ret };
    store.updateReturn(ret.id, { status, decidedBy: by, decisionNote: note });
    store.count(`return_${status}`);
    await syncShopify(ret, `Return ${ret.id} ${status} by ${by}${note ? `: ${note}` : ''}`, [status === 'approved' ? 'return-approved' : 'return-rejected']);
    await send(ret.chatId, M.returnDecided({ ...ret, status }, returnInstructions(ret.reason, profile), note)).catch((err) => logger.warn(`[bot] could not message buyer: ${err.message}`));
    notifyWebhook?.({ type: `return_${status}`, return: { ...ret, status }, by, note });
    return { ok: true, ret: store.findReturn(ret.id) };
  }

  // ---------- human handoff
  async function handoff(chatId, reason, lastMessage = '') {
    store.count('handoff');
    if (!staffChat) return send(chatId, `You can reach our team at <b>${esc(profile.support_email)}</b>${profile.support_hours ? ` (${esc(profile.support_hours)})` : ''}. Please include your order number.`, { reply_markup: MAIN_MENU });
    const user = store.touchUser(chatId);
    const t = await send(staffChat, M.staffTicket({ user, chatId, reason, orders: store.linkedOrders(chatId, sec.linkDays), lastMessage }));
    store.openHandoff(chatId, t?.message_id);
    store.clearSession(chatId);
    return send(chatId, `🙋 I've passed you to our team${profile.support_hours ? ` (${esc(profile.support_hours)})` : ''}. Write your message here and a person will reply in this chat.\n\nType /menu to go back to the bot.`);
  }

  async function relayToStaff(chatId, m) {
    const user = store.touchUser(chatId, m.from);
    const head = `💬 <b>${esc(user.name || 'Buyer')}</b> (chat <code>${esc(chatId)}</code>):`;
    let sentMsg;
    if (m.photo) sentMsg = await tg.call('sendPhoto', { chat_id: staffChat, photo: m.photo.at(-1).file_id, caption: `${head} ${esc(m.caption || '')}`.slice(0, 1000), parse_mode: 'HTML' });
    else sentMsg = await send(staffChat, `${head}\n${esc(m.text || '')}`);
    if (sentMsg?.message_id) store.mapTicket(sentMsg.message_id, chatId);
  }

  // ---------- staff chat
  const isAdmin = (from) => !config.telegram.adminIds.length || config.telegram.adminIds.includes(String(from?.id));

  async function handleStaff(m) {
    const text = m.text || m.caption || '';
    const [cmd, arg, ...rest] = text.trim().split(/\s+/);
    if (/^\/whoami/.test(cmd)) return send(m.chat.id, `This chat ID is <code>${m.chat.id}</code>.`);
    if (/^\/(approve|reject)/.test(cmd)) {
      if (!isAdmin(m.from)) return send(m.chat.id, 'Only admins can decide returns.');
      if (!arg) return send(m.chat.id, `Usage: ${cmd.split('@')[0]} R1001-ABCD [note]`);
      const r = await decideReturn(arg, cmd.startsWith('/approve') ? 'approved' : 'rejected', { note: rest.join(' '), by: m.from?.first_name || 'staff' });
      return send(m.chat.id, r.error ? `⚠️ ${esc(r.error)}` : `Return ${esc(r.ret.id)} ${r.ret.status}. The customer was notified.`);
    }
    if (/^\/pending/.test(cmd)) {
      const list = store.returns({ status: 'pending', limit: 20 });
      return send(m.chat.id, list.length ? list.map((r) => `⏳ <b>${esc(r.id)}</b> · #${esc(r.orderNumber)} · ${esc(reasonLabel(r.reason))} · ${M.money(r.value, r.currency)}`).join('\n') : 'No pending returns.');
    }
    if (/^\/close/.test(cmd) && arg) {
      store.closeHandoff(arg);
      await send(arg, 'Our team has closed this chat. Type /menu any time if you need anything else.', { reply_markup: MAIN_MENU }).catch(() => {});
      return send(m.chat.id, `Chat ${esc(arg)} closed.`);
    }
    const target = m.reply_to_message && store.chatForTicket(m.reply_to_message.message_id);
    if (!target) return;
    const from = esc(m.from?.first_name || 'Support');
    if (m.photo) await tg.call('sendPhoto', { chat_id: target, photo: m.photo.at(-1).file_id, caption: `💬 ${from} (support): ${esc(m.caption || '')}`.slice(0, 1000), parse_mode: 'HTML' });
    else await send(target, `💬 <b>${from}</b> (support):\n${esc(text)}`);
    store.count('staff_reply');
  }

  async function handleStaffCallback(q) {
    const [action, id] = q.data.split(':');
    if (!isAdmin(q.from)) return tg.call('answerCallbackQuery', { callback_query_id: q.id, text: 'Only admins can decide returns.', show_alert: true });
    const r = await decideReturn(id, action === 'sa' ? 'approved' : 'rejected', { by: q.from?.first_name || 'staff' });
    await tg.call('answerCallbackQuery', { callback_query_id: q.id, text: r.error || `Return ${r.ret.status}` });
    if (!r.error) await edit(q.message.chat.id, q.message.message_id, `${q.message.text ? esc(q.message.text) : ''}\n\n<b>${r.ret.status === 'approved' ? '✅ Approved' : '❌ Rejected'}</b> by ${esc(q.from?.first_name || 'staff')}`).catch(() => {});
  }

  // ---------- buyer messages
  async function handleCommand(chatId, cmd, arg, m) {
    const name = m.from?.first_name || '';
    switch (cmd) {
      case 'start': {
        store.clearSession(chatId);
        store.closeHandoff(chatId);
        const deep = arg.match(/^(track|return)_(\d+)$/); // t.me/bot?start=track_1001 links from emails / the store
        if (deep) return startVerify(chatId, deep[1], deep[2]);
        return send(chatId, M.welcome(name, profile), { reply_markup: MAIN_MENU });
      }
      case 'menu':
        store.clearSession(chatId);
        store.closeHandoff(chatId);
        return send(chatId, 'How can I help?', { reply_markup: MAIN_MENU });
      case 'help':
        return send(chatId, M.helpText(profile), { reply_markup: MAIN_MENU });
      case 'track':
      case 'return': {
        // "/return 1008 me@x.com" or "/track #1001 +1 555 0101"
        const number = extractOrderNumber(arg) || (arg.match(/^#?(\d{3,10})\b/) || [])[1] || null;
        const rest = number ? arg.replace(new RegExp(`#?${number}`), '') : arg;
        return startVerify(chatId, cmd, number, extractEmail(rest) || extractPhone(rest));
      }
      case 'orders':
        return listOrders(chatId);
      case 'returns':
        return send(chatId, M.returnsList(store.returnsForChat(chatId)));
      case 'human':
        return handoff(chatId, 'asked for a person', arg);
      case 'stop':
        store.unsubscribeAll(chatId);
        return send(chatId, '🔕 Delivery notifications are off.');
      case 'cancel':
        store.clearSession(chatId);
        store.closeHandoff(chatId);
        return send(chatId, 'Cancelled.', { reply_markup: MAIN_MENU });
      case 'whoami':
        return send(chatId, `Your chat ID is <code>${chatId}</code>.`);
      default:
        return send(chatId, M.helpText(profile));
    }
  }

  async function handleMessage(m) {
    const chatId = m.chat.id;
    if (staffChat && String(chatId) === String(staffChat)) return handleStaff(m);
    if (m.chat.type !== 'private') return;
    store.touchUser(chatId, m.from);
    const text = (m.text || '').trim();
    const sess = store.session(chatId);

    if (text.startsWith('/')) {
      const [c, ...rest] = text.slice(1).split(/\s+/);
      return handleCommand(chatId, c.split('@')[0].toLowerCase(), rest.join(' '), m);
    }
    if (store.handoff(chatId) && staffChat) {
      await relayToStaff(chatId, m);
      return;
    }
    if (m.photo) {
      if (sess.flow === 'return' && sess.step === 'photo') {
        const photos = [...sess.photos, m.photo.at(-1).file_id].slice(0, 5);
        store.setSession(chatId, { ...sess, photos });
        return returnStep(chatId, { ...sess, photos });
      }
      return send(chatId, 'Thanks for the photo! To report a problem with an item, start a return with /return or tap <b>Talk to a person</b>.', { reply_markup: MAIN_MENU });
    }
    if (!text) return;

    if (sess.flow === 'verify') {
      if (sess.step === 'order') {
        const number = extractOrderNumber(text, { loose: true });
        if (!number) return send(chatId, `That doesn't look like an order number. ${M.askOrderNumber()}`, { reply_markup: CANCEL });
        const contact = extractEmail(text) || extractPhone(text.replace(new RegExp(`#?${number}`), ''));
        if (contact) return verify(chatId, { ...sess, number }, contact);
        store.setSession(chatId, { ...sess, number, step: 'contact' });
        return send(chatId, M.askContact(number), { reply_markup: CANCEL });
      }
      const contact = extractEmail(text) || extractPhone(text);
      if (!contact) return send(chatId, `Please send the <b>email address</b> or <b>phone number</b> used for order #${esc(sess.number)}.`, { reply_markup: CANCEL });
      return verify(chatId, sess, contact);
    }
    if (sess.flow === 'return' && sess.step === 'note') {
      const next = { ...sess, note: text.slice(0, 500), step: 'confirm' };
      store.setSession(chatId, next);
      return returnStep(chatId, next);
    }

    // Free text: let the NLU route it.
    await tg.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const u = await nlu.understand(text);
    store.count(`intent_${u.intent}`);
    if (u.intent === 'track' || u.intent === 'return') {
      const linked = store.linkedOrders(chatId, sec.linkDays);
      const number = u.order_number || (linked.length === 1 ? linked[0].number : null);
      if (!number && linked.length > 1) return listOrders(chatId);
      return startVerify(chatId, u.intent, number, u.email);
    }
    if (u.intent === 'human') return handoff(chatId, 'asked for a person', text);
    if (u.intent === 'greeting') return send(chatId, M.welcome(m.from?.first_name, profile), { reply_markup: MAIN_MENU });
    if (u.answer) {
      store.count('faq_answered');
      return send(chatId, esc(u.answer), { reply_markup: MAIN_MENU });
    }
    store.count('not_understood');
    return send(chatId, `I'm not sure I can help with that here. I can track orders and handle returns, or connect you with a person.`, { reply_markup: MAIN_MENU });
  }

  // ---------- buttons
  async function handleCallback(q) {
    const chatId = q.message?.chat.id;
    const msgId = q.message?.message_id;
    const data = q.data || '';
    if (staffChat && String(chatId) === String(staffChat) && /^s[ar]:/.test(data)) return handleStaffCallback(q);
    const [action, val] = data.split(':');
    // Each button press is answered exactly once; sub/uns answer with a toast below.
    if (action !== 'sub' && action !== 'uns') await tg.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    const sess = store.session(chatId);
    const guard = (n) => store.isLinked(chatId, n, sec.linkDays);

    switch (action) {
      case 'menu':
        if (val === 'track') return listOrders(chatId);
        if (val === 'return') {
          const linked = store.linkedOrders(chatId, sec.linkDays);
          return linked.length === 1 ? startReturn(chatId, linked[0].number) : startVerify(chatId, 'return');
        }
        if (val === 'orders') return listOrders(chatId);
        if (val === 'new') return startVerify(chatId, 'track');
        return;
      case 'human':
        return handoff(chatId, 'tapped "Talk to a person"');
      case 'cancel':
        store.clearSession(chatId);
        return show(chatId, msgId, 'Cancelled. How else can I help?', { reply_markup: MAIN_MENU });
      case 'ord':
      case 'ref':
        if (!guard(val)) return startVerify(chatId, 'track', val);
        return showOrder(chatId, val, action === 'ref' ? msgId : null);
      case 'sub':
      case 'uns': {
        if (!guard(val)) return startVerify(chatId, 'track', val);
        const order = await loadOrder(chatId, val);
        if (action === 'sub') store.subscribe(chatId, order, shipmentSignature(order));
        else store.unsubscribe(chatId, val);
        store.count(action === 'sub' ? 'subscribed' : 'unsubscribed');
        await tg.call('answerCallbackQuery', { callback_query_id: q.id, text: action === 'sub' ? "🔔 I'll message you when it moves" : '🔕 Updates off' }).catch(() => {});
        return showOrder(chatId, val, msgId, order);
      }
      case 'ret':
        if (!guard(val)) return startVerify(chatId, 'return', val);
        return startReturn(chatId, val, msgId);
    }

    // Return flow buttons need an active return session.
    if (sess.flow !== 'return') return show(chatId, msgId, 'This step has expired. Start again with /return.', { reply_markup: MAIN_MENU });
    if (action === 'ri') {
      const order = await loadOrder(chatId, sess.number);
      const row = returnRows(order, sess.sel)[Number(val)];
      if (!row?.elig.ok) return;
      const cur = sess.sel[row.item.id] || 0;
      const nextQty = cur >= row.elig.maxQty ? 0 : cur + 1; // tap again for more units, wraps to 0
      const sel = { ...sess.sel, [row.item.id]: nextQty };
      if (!nextQty) delete sel[row.item.id];
      const next = { ...sess, sel };
      store.setSession(chatId, next);
      return returnStep(chatId, next, msgId);
    }
    if (action === 'rgo') {
      if (!Object.keys(sess.sel).length) return;
      const next = { ...sess, step: 'reason' };
      store.setSession(chatId, next);
      return returnStep(chatId, next, msgId);
    }
    if (action === 'rr') {
      const next = { ...sess, reason: val, step: DEFECT_REASONS.includes(val) ? 'photo' : 'note' };
      store.setSession(chatId, next);
      return returnStep(chatId, next, msgId);
    }
    if (action === 'rskip') {
      const next = { ...sess, step: sess.step === 'photo' ? 'note' : 'confirm' };
      store.setSession(chatId, next);
      return returnStep(chatId, next, msgId);
    }
    if (action === 'rok') return submitReturn(chatId, sess, msgId);
  }

  // ---------- entry points
  async function handleUpdate(update) {
    if (update.callback_query) return handleCallback(update.callback_query);
    const m = update.message;
    if (!m?.chat || m.from?.is_bot) return;
    return handleMessage(m);
  }

  /** Per-chat queue: each chat's updates run in order, different chats in parallel. */
  function enqueue(update) {
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? 'other';
    const prev = queues.get(chatId) || Promise.resolve();
    const next = prev
      .then(() => handleUpdate(update))
      .catch(async (err) => {
        logger.error(`[bot] update ${update.update_id} failed: ${err.stack || err.message}`);
        if (chatId !== 'other' && String(chatId) !== String(staffChat))
          await send(chatId, "Sorry, I couldn't reach the store system just now. Please try again in a minute, or tap <b>Talk to a person</b>.", { reply_markup: MAIN_MENU }).catch(() => {});
      })
      .finally(() => {
        if (queues.get(chatId) === next) queues.delete(chatId);
      });
    queues.set(chatId, next);
    return next;
  }

  const idle = () => Promise.all([...queues.values()]);

  return { handleUpdate, enqueue, idle, decideReturn, send, showOrder };
}

export const BOT_COMMANDS = [
  { command: 'track', description: 'Track my order' },
  { command: 'return', description: 'Start a return' },
  { command: 'orders', description: 'My verified orders' },
  { command: 'returns', description: 'My return requests' },
  { command: 'human', description: 'Talk to a person' },
  { command: 'stop', description: 'Stop delivery notifications' },
  { command: 'help', description: 'Help' },
];
