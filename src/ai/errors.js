/**
 * Error classification for the multi-model fallback router.
 *
 * Every provider throws an AIError with a `kind`. The router uses the kind to
 * decide how long to skip that model (cooldown) before trying it again.
 */

export const ERROR_KINDS = {
  rate_limit: 'rate_limit', // 429: too many requests / quota for now
  quota: 'quota', // 429 with a daily quota: skip for a long time
  overloaded: 'overloaded', // 500/502/503/504/529: provider busy or down
  timeout: 'timeout', // no answer within our time limit
  network: 'network', // DNS, connection reset, offline
  auth: 'auth', // 401/403: bad or missing key
  not_found: 'not_found', // 404: model renamed or retired
  bad_request: 'bad_request', // 400/422: request rejected (prompt too long, unsupported option)
  bad_output: 'bad_output', // empty, blocked or unparseable answer
  aborted: 'aborted', // caller cancelled
};

export class AIError extends Error {
  constructor(message, { kind = ERROR_KINDS.bad_output, status, retryAfterMs, provider, model, cause } = {}) {
    super(message);
    this.name = 'AIError';
    Object.assign(this, { kind, status, retryAfterMs, provider, model });
    if (cause) this.cause = cause;
  }
}

/** Map an HTTP status (+ error body text) to an error kind. */
export function kindFromStatus(status, bodyText = '') {
  const text = String(bodyText).toLowerCase();
  if (status === 429) {
    return /per ?day|perday|daily|requests per day|billing|insufficient|credits/.test(text) ? ERROR_KINDS.quota : ERROR_KINDS.rate_limit;
  }
  if (status === 402) return ERROR_KINDS.quota; // OpenRouter: out of credits
  if (status === 401 || status === 403) return ERROR_KINDS.auth;
  if (status === 404) return ERROR_KINDS.not_found;
  if (status === 408) return ERROR_KINDS.timeout;
  if (status === 400 || status === 413 || status === 422) {
    // Some providers return 400 for an invalid key.
    if (/api key|api_key|unauthenticated|permission/.test(text)) return ERROR_KINDS.auth;
    if (/not found|does not exist|no endpoints|unknown model|is not a valid model/.test(text)) return ERROR_KINDS.not_found;
    return ERROR_KINDS.bad_request;
  }
  if (status >= 500) return ERROR_KINDS.overloaded;
  return ERROR_KINDS.bad_request;
}

/** Parse Retry-After (seconds or HTTP date) or Gemini's RetryInfo "41s" into ms. */
export function parseRetryAfter(headerValue, body, now = Date.now()) {
  if (headerValue) {
    const secs = Number(headerValue);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(headerValue);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const details = body?.error?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      const m = typeof d?.retryDelay === 'string' && d.retryDelay.match(/^([\d.]+)s$/);
      if (m) return Math.round(Number(m[1]) * 1000);
    }
  }
  return undefined;
}

/** Wrap a fetch failure (abort/timeout/network) into an AIError. */
export function fetchFailure(err, { provider, model, callerSignal } = {}) {
  if (callerSignal?.aborted) return new AIError(`${provider} request cancelled`, { kind: ERROR_KINDS.aborted, provider, model, cause: err });
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new AIError(`${provider} timed out`, { kind: ERROR_KINDS.timeout, provider, model, cause: err });
  }
  return new AIError(`${provider} network error: ${err?.message || err}`, { kind: ERROR_KINDS.network, provider, model, cause: err });
}

/** Read a JSON body without throwing; keeps the raw text for error messages. */
export async function readBody(res) {
  const text = await res.text().catch(() => '');
  try {
    return { text, json: text ? JSON.parse(text) : {} };
  } catch {
    return { text, json: {} };
  }
}

export function shortMessage(body, text, max = 200) {
  const m = body?.error?.message || body?.message || body?.error || text || '';
  const s = typeof m === 'string' ? m : JSON.stringify(m);
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}
