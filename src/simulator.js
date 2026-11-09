/**
 * Drive the bot like real Telegram users and staff would, without Telegram.
 * Works with the mock Telegram client (src/telegram/mock.js). Used by `chat`, `demo` and tests.
 */
export function createSimulator(app, { staffChatId = app.config.telegram.staffChatId } = {}) {
  const tg = app.tg;
  let updateId = 1;
  let photoSeq = 1;
  const users = {};
  const user = (chatId, name) => (users[chatId] ||= { id: Number(chatId), is_bot: false, first_name: name || `User${chatId}`, language_code: 'en' });

  async function deliver(update) {
    await app.bot.enqueue({ update_id: updateId++, ...update });
    await app.bot.idle();
  }

  function lastWithButtons(chatId) {
    return tg.calls.filter((c) => String(c.params.chat_id) === String(chatId) && c.params.reply_markup?.inline_keyboard).at(-1);
  }

  return {
    user,
    /** Buyer sends a text message. */
    say(chatId, text, name) {
      return deliver({ message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: 'private' }, from: user(chatId, name), text } });
    },
    /** Buyer sends a photo. */
    photo(chatId, caption = '') {
      const id = `photo_${photoSeq++}`;
      return deliver({ message: { message_id: updateId, chat: { id: Number(chatId), type: 'private' }, from: user(chatId), photo: [{ file_id: `${id}_small` }, { file_id: id }], caption } });
    },
    /** Buyer presses a button (matched by label text) in the latest message that has buttons. */
    async press(chatId, label, from) {
      const msg = lastWithButtons(chatId);
      const btn = (msg?.params.reply_markup.inline_keyboard || []).flat().find((b) => b.callback_data && b.text.toLowerCase().includes(String(label).toLowerCase()));
      if (!btn) throw new Error(`No button "${label}" for chat ${chatId}. Buttons: ${this.buttons(chatId).map((b) => b.text).join(' | ') || 'none'}`);
      const message_id = msg.message_id || msg.params.message_id;
      await deliver({ callback_query: { id: `cb${updateId}`, from: from || user(chatId), data: btn.callback_data, message: { message_id, chat: { id: Number(chatId), type: Number(chatId) < 0 ? 'supergroup' : 'private' }, text: String(msg.params.text || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') } } }); // Telegram sends plain text back
      return btn;
    },
    /** Staff member writes in the staff group (optionally replying to the latest bot message there). */
    staffSay(text, { reply = false, name = 'Sam' } = {}) {
      const last = tg.calls.filter((c) => String(c.params.chat_id) === String(staffChatId) && (c.message_id || c.method === 'sendPhoto')).at(-1);
      return deliver({
        message: { message_id: updateId, chat: { id: Number(staffChatId), type: 'supergroup' }, from: { id: 999, first_name: name }, text, ...(reply && last ? { reply_to_message: { message_id: last.message_id } } : {}) },
      });
    },
    staffPress(label) {
      return this.press(staffChatId, label, { id: 999, first_name: 'Sam' });
    },
    buttons(chatId) {
      const m = lastWithButtons(chatId);
      return (m?.params.reply_markup.inline_keyboard || []).flat().map((b) => ({ text: b.text, data: b.callback_data, url: b.url }));
    },
    texts: (chatId) => tg.textsTo(chatId),
    last: (chatId) => tg.textsTo(chatId).at(-1) || '',
  };
}

const ANSI = process.stdout.isTTY && !process.env.NO_COLOR;
/** Telegram HTML -> terminal text. */
export function htmlToTerminal(html) {
  const b = (s) => (ANSI ? `\x1b[1m${s}\x1b[0m` : s);
  const i = (s) => (ANSI ? `\x1b[3m${s}\x1b[0m` : s);
  const code = (s) => (ANSI ? `\x1b[36m${s}\x1b[0m` : s);
  return String(html || '')
    .replace(/<b>([\s\S]*?)<\/b>/g, (_, s) => b(s))
    .replace(/<i>([\s\S]*?)<\/i>/g, (_, s) => i(s))
    .replace(/<code>([\s\S]*?)<\/code>/g, (_, s) => code(s))
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function renderCall(call, { label } = {}) {
  const p = call.params;
  const head = label || (call.method === 'editMessageText' ? '(edited)' : '');
  const body = call.method === 'sendPhoto' ? `[photo ${p.photo}] ${htmlToTerminal(p.caption || '')}` : htmlToTerminal(p.text);
  const rows = (p.reply_markup?.inline_keyboard || []).map((row) => row.map((btn) => (btn.url ? `[${btn.text} ↗]` : `[${btn.text}]`)).join(' '));
  return `${head ? `${head} ` : ''}${body}${rows.length ? `\n${rows.join('\n')}` : ''}`;
}
