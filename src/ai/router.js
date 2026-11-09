import { AIError, ERROR_KINDS } from './errors.js';

/**
 * Multi-model fallback router.
 *
 * Tries an ordered chain of { provider, model } targets until one answers.
 * Compared with a plain try/catch cascade it adds:
 *  - a timeout per attempt and a total time budget, so a hung provider never stalls a reply;
 *  - cooldowns (circuit breaker): a model that just returned 429/503 is skipped for a while,
 *    so the next requests go straight to a healthy model instead of waiting for it to fail again;
 *  - longer cooldowns for daily quota, bad keys and retired models;
 *  - hedging: if a model has not answered after `hedgeAfterMs`, the next one starts in parallel
 *    and the first good answer wins (the slow one is cancelled and parked briefly);
 *  - output validation: if `parse` throws (e.g. invalid JSON), the next model is tried;
 *  - a last-chance pass over cooling models when nothing else is left;
 *  - health stats for /health and `doctor`.
 */

const DEFAULT_COOLDOWNS = {
  [ERROR_KINDS.rate_limit]: 60_000,
  [ERROR_KINDS.quota]: 60 * 60_000,
  [ERROR_KINDS.overloaded]: 30_000,
  [ERROR_KINDS.timeout]: 30_000,
  [ERROR_KINDS.network]: 15_000,
  [ERROR_KINDS.auth]: 6 * 60 * 60_000,
  [ERROR_KINDS.not_found]: 6 * 60 * 60_000,
  [ERROR_KINDS.bad_request]: 0,
  [ERROR_KINDS.bad_output]: 0,
  [ERROR_KINDS.aborted]: 0,
  slow: 20_000, // lost a hedge race: let other models go first for a moment
};

/** Kinds that will not fix themselves - never retried in the last-chance pass. */
const PERMANENT = new Set([ERROR_KINDS.auth, ERROR_KINDS.not_found, ERROR_KINDS.quota]);
const MAX_BACKOFF = 8;

export function createLLMRouter({
  chain,
  providers,
  timeoutMs = 12_000,
  totalBudgetMs = 30_000,
  hedgeAfterMs = 0, // 0 = strictly one model at a time
  cooldowns = {},
  maxCooldownMs = 30 * 60_000,
  lastChance = true,
  now = () => Date.now(),
  onEvent = () => {},
} = {}) {
  if (!Array.isArray(chain)) throw new Error('createLLMRouter: chain must be an array');
  const cool = { ...DEFAULT_COOLDOWNS, ...cooldowns };

  const targets = chain.map((t, i) => {
    const provider = providers[t.provider];
    return {
      id: t.id || `${t.provider}:${t.model}`,
      index: i,
      provider: t.provider,
      model: t.model,
      timeoutMs: t.timeoutMs,
      client: provider,
      enabled: Boolean(provider?.configured),
      disabledReason: !provider ? 'unknown provider' : provider.configured ? null : provider.disabledReason || 'no API key',
      coolingUntil: 0,
      lastErrorKind: null,
      lastError: null,
      consecutiveFailures: 0,
      successes: 0,
      failures: 0,
      totalMs: 0,
      lastUsedAt: null,
    };
  });

  const emit = (type, data) => {
    try {
      onEvent({ type, at: now(), ...data });
    } catch {
      /* listeners must never break a request */
    }
  };

  function cooldownFor(target, err) {
    const base = cool[err.kind] ?? 0;
    if (!base && !err.retryAfterMs) return 0;
    if (PERMANENT.has(err.kind)) return Math.max(base, err.retryAfterMs || 0);
    // Repeated failures double the cooldown (capped); a provider hint wins if longer.
    const backoff = base * 2 ** Math.min(target.consecutiveFailures - 1, MAX_BACKOFF);
    return Math.min(Math.max(backoff, err.retryAfterMs || 0), maxCooldownMs);
  }

  /** One call to one target. `cancel` is the hedge controller (aborting it is not a failure). */
  async function attempt(target, request, { deadline, callerSignal, cancel, isLast }) {
    const remaining = deadline - now();
    // A tight timeout only makes sense when there is another model to fall back to.
    // The last candidate gets the whole remaining budget (a slow answer beats no answer).
    const limit = isLast ? remaining : Math.min(target.timeoutMs || request.timeoutMs || timeoutMs, remaining);
    const signal = callerSignal ? AbortSignal.any([callerSignal, cancel.signal]) : cancel.signal;
    const started = now();
    emit('attempt', { target: target.id });
    try {
      const out = await target.client.complete({ ...request, model: target.model, timeoutMs: limit, signal });
      if (cancel.signal.aborted && !callerSignal?.aborted) throw new AIError('cancelled (another model answered first)', { kind: ERROR_KINDS.aborted });
      let data;
      if (request.parse) {
        try {
          data = request.parse(out.text);
        } catch (err) {
          throw new AIError(`${target.id} gave unusable output: ${err.message}`, { kind: ERROR_KINDS.bad_output, provider: target.provider, model: target.model });
        }
      }
      const ms = now() - started;
      Object.assign(target, { consecutiveFailures: 0, coolingUntil: 0, lastUsedAt: now() });
      target.successes++;
      target.totalMs += ms;
      emit('success', { target: target.id, ms });
      return { ok: true, result: { ...out, data, provider: target.provider, model: target.model, target: target.id, ms } };
    } catch (raw) {
      const ms = now() - started;
      // Cancelled because a hedged model won: park it briefly (it was slow), but it did not fail.
      if (cancel.signal.aborted && !callerSignal?.aborted) {
        if (cool.slow) target.coolingUntil = Math.max(target.coolingUntil, now() + cool.slow);
        target.lastErrorKind = 'slow';
        emit('cancelled', { target: target.id, ms });
        return { ok: false, cancelled: true, error: new AIError('cancelled', { kind: ERROR_KINDS.aborted }), ms };
      }
      const err = raw instanceof AIError ? raw : new AIError(raw?.message || String(raw), { kind: ERROR_KINDS.network, provider: target.provider, model: target.model, cause: raw });
      target.failures++;
      target.consecutiveFailures++;
      target.lastErrorKind = err.kind;
      target.lastError = err.message;
      target.lastUsedAt = now();
      const wait = cooldownFor(target, err);
      if (wait > 0) target.coolingUntil = now() + wait;
      emit('failure', { target: target.id, kind: err.kind, status: err.status, message: err.message, ms, cooldownMs: wait });
      return { ok: false, error: err, ms };
    }
  }

  /**
   * @param {object} request { system, messages:[{role,content}], json, temperature, maxTokens, parse,
   *                           timeoutMs, totalBudgetMs, hedgeAfterMs, signal, only }
   * @returns {Promise<{text, data, provider, model, target, ms, attempts, totalMs}>}
   */
  async function generate(request) {
    if (!request?.messages?.length) throw new Error('generate: messages are required');
    const { signal, only, hedgeAfterMs: hedgeOverride, ...req } = request;
    const hedgeMs = only ? 0 : (hedgeOverride ?? hedgeAfterMs);
    // `only` pins one target (used by health checks); cooldowns are ignored for it.
    const pool = only ? targets.filter((t) => t.id === only) : targets;
    const started = now();
    const deadline = started + (request.totalBudgetMs || totalBudgetMs);
    const attempts = [];
    const tried = new Set();
    const ready = (t) => t.enabled && !tried.has(t) && (only || t.coolingUntil <= now());
    const retryable = (t) => t.enabled && !tried.has(t) && !PERMANENT.has(t.lastErrorKind);

    /** Run candidates in order; with hedging, keep at most 2 in flight. */
    async function race(candidates) {
      const queue = [...candidates];
      const inflight = new Set();
      let stop = false;

      const launch = () => {
        while (queue.length) {
          if (stop || signal?.aborted || deadline - now() < 500) return false;
          const target = queue.shift();
          if (tried.has(target)) continue;
          tried.add(target);
          const others = pool.some((t) => t !== target && (ready(t) || (lastChance && retryable(t))));
          const cancel = new AbortController();
          const entry = { target, cancel };
          entry.promise = attempt(target, req, { deadline, callerSignal: signal, cancel, isLast: !others }).then((r) => {
            if (!r.cancelled) attempts.push({ target: target.id, ok: r.ok, ms: r.ok ? r.result.ms : r.ms, kind: r.error?.kind, error: r.error?.message });
            return { entry, r };
          });
          inflight.add(entry);
          return true;
        }
        return false;
      };

      launch();
      while (inflight.size) {
        let timer;
        const canHedge = hedgeMs > 0 && inflight.size < 2 && queue.length > 0;
        const hedge = canHedge ? new Promise((res) => (timer = setTimeout(() => res({ hedge: true }), hedgeMs))) : null;
        const settled = await Promise.race([...[...inflight].map((e) => e.promise), ...(hedge ? [hedge] : [])]);
        clearTimeout(timer);
        if (settled.hedge) {
          if (launch()) emit('hedge', { targets: [...inflight].map((e) => e.target.id) });
          continue;
        }
        inflight.delete(settled.entry);
        if (settled.r.ok) {
          for (const e of inflight) e.cancel.abort();
          return settled.r.result;
        }
        if (settled.r.error.kind === ERROR_KINDS.aborted && signal?.aborted) {
          stop = true;
          for (const e of inflight) e.cancel.abort();
          break;
        }
        if (!inflight.size) launch();
      }
      return null;
    }

    // Pass 1: every enabled target that is not cooling down, in chain order.
    const first = pool.filter((t) => {
      if (!t.enabled) return false;
      if (!only && t.coolingUntil > now()) {
        emit('skip', { target: t.id, reason: t.lastErrorKind, until: t.coolingUntil });
        return false;
      }
      return true;
    });
    let result = await race(first);

    // Pass 2: everything healthy failed or was cooling. Cooldowns are estimates, so try the
    // cooling targets anyway (soonest-to-recover first) - except keys/models that cannot work.
    if (!result && lastChance && !signal?.aborted) {
      result = await race(pool.filter(retryable).sort((a, b) => a.coolingUntil - b.coolingUntil));
    }
    if (result) return { ...result, attempts, totalMs: now() - started };

    const enabled = pool.filter((t) => t.enabled).length;
    const reason = !enabled
      ? 'No AI provider is configured (set GEMINI_API_KEY, NVIDIA_API_KEY or OPENROUTER_API_KEY).'
      : signal?.aborted
        ? 'Request cancelled.'
        : `All AI providers failed (${attempts.map((a) => `${a.target}: ${a.kind}`).join(', ') || 'all cooling down / out of time'}).`;
    emit('exhausted', { attempts, reason });
    const err = new AIError(reason, { kind: signal?.aborted ? ERROR_KINDS.aborted : ERROR_KINDS.overloaded });
    err.attempts = attempts;
    throw err;
  }

  function status() {
    const t = now();
    return targets.map((x) => ({
      id: x.id,
      provider: x.provider,
      model: x.model,
      enabled: x.enabled,
      disabledReason: x.disabledReason,
      state: !x.enabled ? 'disabled' : x.coolingUntil > t ? 'cooling' : 'ready',
      coolingForMs: Math.max(0, x.coolingUntil - t),
      lastErrorKind: x.lastErrorKind,
      lastError: x.lastError,
      successes: x.successes,
      failures: x.failures,
      avgMs: x.successes ? Math.round(x.totalMs / x.successes) : null,
    }));
  }

  return {
    generate,
    status,
    get enabledCount() {
      return targets.filter((t) => t.enabled).length;
    },
    /** Clear all cooldowns (e.g. after fixing a key). */
    reset() {
      for (const t of targets) Object.assign(t, { coolingUntil: 0, consecutiveFailures: 0, lastErrorKind: null, lastError: null });
    },
  };
}
