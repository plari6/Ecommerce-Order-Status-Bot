/** Telegram Bot API over fetch (no SDK). */
export class TelegramApiError extends Error {
  constructor(method, status, body) {
    super(`Telegram ${method} failed: ${status} ${body?.description || ''}`.trim());
    this.status = status;
    this.description = body?.description || '';
    this.retryAfter = body?.parameters?.retry_after;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * -> { call(method, params), kind }. Retries 429 using retry_after (max 2 times).
 * 400 "message is not modified" is ignored (harmless when a button is pressed twice).
 */
export function createTelegramApi(token, { fetchImpl = fetch, base = 'https://api.telegram.org', wait = sleep } = {}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  async function call(method, params = {}, { timeoutMs = 15_000 } = {}, attempt = 0) {
    const res = await fetchImpl(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return body.result;
    const err = new TelegramApiError(method, res.status, body);
    if (err.status === 429 && attempt < 2) {
      await wait((err.retryAfter || 1) * 1000);
      return call(method, params, { timeoutMs }, attempt + 1);
    }
    if (err.status === 400 && /message is not modified/i.test(err.description)) return true;
    throw err;
  }
  return { kind: 'telegram', call };
}

/** Escape text for parse_mode HTML. */
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Split long replies at paragraph/line boundaries (Telegram limit 4096). */
export function splitMessage(text, max = 4000) {
  const parts = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Inline keyboard helper: rows of [text, callback_data] or {text, url}. */
export function keyboard(rows) {
  return {
    inline_keyboard: rows
      .filter((r) => r && r.length)
      .map((row) => row.filter(Boolean).map((b) => (Array.isArray(b) ? { text: b[0], callback_data: String(b[1]).slice(0, 64) } : b))),
  };
}
