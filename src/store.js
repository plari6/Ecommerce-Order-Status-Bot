import fs from 'node:fs';
import path from 'node:path';

const DAY = 864e5;
const empty = () => ({ sessions: {}, links: {}, attempts: {}, subscriptions: {}, returns: [], tickets: {}, handoff: {}, users: {}, stats: { since: new Date().toISOString(), events: {} } });

/**
 * JSON-file database (atomic writes, saved at most every 300 ms). file = null -> memory only.
 * Holds: conversation state per chat, orders each chat has verified, shipment subscriptions,
 * return requests, human-handoff tickets and usage counters.
 */
export function createStore(file, { now = Date.now } = {}) {
  let s = empty();
  if (file && fs.existsSync(file)) {
    try {
      s = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      const bad = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, bad);
      console.warn(`[store] ${file} was unreadable (${err.message}); moved to ${bad}`);
    }
  }
  let timer = null;
  const flush = () => {
    timer = null;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, file);
  };
  const save = () => {
    if (file && !timer) timer = setTimeout(flush, 300);
  };
  const k = String;

  return {
    file,
    flush() {
      if (timer) clearTimeout(timer);
      flush();
    },
    // ---- conversation state
    session(chatId) {
      return s.sessions[k(chatId)] || { flow: null };
    },
    setSession(chatId, data) {
      s.sessions[k(chatId)] = { ...data, updatedAt: new Date(now()).toISOString() };
      save();
    },
    clearSession(chatId) {
      delete s.sessions[k(chatId)];
      save();
    },
    touchUser(chatId, from = {}) {
      const u = s.users[k(chatId)] || { firstSeen: new Date(now()).toISOString() };
      Object.assign(u, { name: [from.first_name, from.last_name].filter(Boolean).join(' '), username: from.username || '', lang: from.language_code || u.lang, lastSeen: new Date(now()).toISOString() });
      s.users[k(chatId)] = u;
      save();
      return u;
    },
    // ---- verified orders per chat
    linkOrder(chatId, order) {
      const l = (s.links[k(chatId)] ||= {});
      l[order.number] = { id: order.id, at: now() };
      save();
    },
    linkedOrders(chatId, days = 30) {
      return Object.entries(s.links[k(chatId)] || {})
        .filter(([, v]) => now() - v.at < days * DAY)
        .sort((a, b) => b[1].at - a[1].at)
        .map(([number, v]) => ({ number, id: v.id }));
    },
    isLinked(chatId, number, days = 30) {
      const v = s.links[k(chatId)]?.[k(number)];
      return Boolean(v && now() - v.at < days * DAY);
    },
    // ---- brute-force protection on order verification
    attemptState(chatId) {
      return s.attempts[k(chatId)] || { count: 0, lockedUntil: 0 };
    },
    recordFailedAttempt(chatId, { max, lockMinutes }) {
      const a = s.attempts[k(chatId)] || { count: 0, lockedUntil: 0 };
      a.count += 1;
      if (a.count >= max) {
        a.lockedUntil = now() + lockMinutes * 60_000;
        a.count = 0;
      }
      s.attempts[k(chatId)] = a;
      save();
      return a;
    },
    resetAttempts(chatId) {
      delete s.attempts[k(chatId)];
      save();
    },
    // ---- shipment notifications
    subscribe(chatId, order, signature) {
      const sub = (s.subscriptions[order.number] ||= { orderId: order.id, chats: [], signature });
      if (!sub.chats.includes(k(chatId))) sub.chats.push(k(chatId));
      sub.signature = signature;
      save();
    },
    unsubscribe(chatId, number) {
      const sub = s.subscriptions[k(number)];
      if (!sub) return;
      sub.chats = sub.chats.filter((c) => c !== k(chatId));
      if (!sub.chats.length) delete s.subscriptions[k(number)];
      save();
    },
    unsubscribeAll(chatId) {
      for (const n of Object.keys(s.subscriptions)) this.unsubscribe(chatId, n);
    },
    subscription(number) {
      return s.subscriptions[k(number)] || null;
    },
    subscriptions() {
      return Object.entries(s.subscriptions).map(([number, v]) => ({ number, ...v }));
    },
    setSignature(number, signature) {
      if (s.subscriptions[k(number)]) {
        s.subscriptions[k(number)].signature = signature;
        save();
      }
    },
    isSubscribed(chatId, number) {
      return Boolean(s.subscriptions[k(number)]?.chats.includes(k(chatId)));
    },
    // ---- returns
    addReturn(r) {
      s.returns.push(r);
      save();
      return r;
    },
    updateReturn(id, patch) {
      const r = s.returns.find((x) => x.id === id);
      if (r) Object.assign(r, patch, { updatedAt: new Date(now()).toISOString() });
      save();
      return r;
    },
    findReturn(id) {
      return s.returns.find((x) => x.id.toLowerCase() === String(id).toLowerCase()) || null;
    },
    returns({ status, limit = 50 } = {}) {
      return s.returns.filter((r) => !status || r.status === status).slice(-limit).reverse();
    },
    returnsForChat(chatId) {
      return s.returns.filter((r) => r.chatId === k(chatId)).reverse();
    },
    /** Quantity of an item already in open (pending/approved) return requests. */
    pendingQty(orderNumber, itemId) {
      return s.returns
        .filter((r) => r.orderNumber === k(orderNumber) && ['pending', 'approved'].includes(r.status))
        .flatMap((r) => r.items)
        .filter((i) => String(i.id) === String(itemId))
        .reduce((n, i) => n + i.quantity, 0);
    },
    // ---- human handoff
    openHandoff(chatId, ticketMessageId) {
      s.handoff[k(chatId)] = { since: now(), ticketMessageId };
      if (ticketMessageId) s.tickets[k(ticketMessageId)] = k(chatId);
      save();
    },
    handoff(chatId) {
      const h = s.handoff[k(chatId)];
      return h && now() - h.since < DAY ? h : null;
    },
    closeHandoff(chatId) {
      delete s.handoff[k(chatId)];
      save();
    },
    mapTicket(staffMessageId, chatId) {
      s.tickets[k(staffMessageId)] = k(chatId);
      save();
    },
    chatForTicket(staffMessageId) {
      return s.tickets[k(staffMessageId)] || null;
    },
    // ---- stats
    count(event, n = 1) {
      s.stats.events[event] = (s.stats.events[event] || 0) + n;
      save();
    },
    stats() {
      const r = s.returns;
      return {
        since: s.stats.since,
        users: Object.keys(s.users).length,
        events: s.stats.events,
        returns: { total: r.length, pending: r.filter((x) => x.status === 'pending').length, approved: r.filter((x) => x.status === 'approved').length, rejected: r.filter((x) => x.status === 'rejected').length },
        subscriptions: Object.values(s.subscriptions).reduce((n, v) => n + v.chats.length, 0),
      };
    },
  };
}
