/**
 * Records Bot API calls instead of sending them. Used by `chat`, `demo` and tests.
 * `onSend` lets the terminal chat print messages as they arrive.
 */
export function createMockTelegram({ onSend, blocked = [] } = {}) {
  const calls = [];
  let messageId = 1000;
  const sent = () => calls.filter((c) => ['sendMessage', 'editMessageText', 'sendPhoto'].includes(c.method));
  return {
    kind: 'mock',
    calls,
    async call(method, params = {}) {
      if (blocked.includes(String(params.chat_id)) && method !== 'answerCallbackQuery') {
        throw Object.assign(new Error('Forbidden: bot was blocked by the user'), { status: 403, description: 'Forbidden: bot was blocked by the user' });
      }
      const entry = { method, params };
      calls.push(entry);
      if (method === 'getMe') return { id: 1, is_bot: true, username: 'demo_order_bot', first_name: 'Order Bot' };
      if (method === 'sendMessage' || method === 'sendPhoto' || method === 'copyMessage') {
        entry.message_id = ++messageId;
        onSend?.(entry);
        return { message_id: entry.message_id, chat: { id: params.chat_id }, text: params.text };
      }
      if (method === 'editMessageText') {
        onSend?.(entry);
        return true;
      }
      return true;
    },
    /** All text sent to a chat (sendMessage + edits), newest last. */
    textsTo(chatId) {
      return sent()
        .filter((c) => String(c.params.chat_id) === String(chatId))
        .map((c) => c.params.text || c.params.caption || '');
    },
    lastTo(chatId) {
      return sent()
        .filter((c) => String(c.params.chat_id) === String(chatId))
        .at(-1);
    },
    /** callback_data / url of every button in the last message to a chat. */
    buttonsTo(chatId) {
      const m = this.lastTo(chatId);
      return (m?.params.reply_markup?.inline_keyboard || []).flat().map((b) => ({ text: b.text, data: b.callback_data, url: b.url }));
    },
    reset() {
      calls.length = 0;
    },
  };
}
