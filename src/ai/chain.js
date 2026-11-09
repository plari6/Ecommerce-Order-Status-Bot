import { createGeminiProvider } from './providers/gemini.js';
import { createOpenAICompatibleProvider, PRESETS } from './providers/openai-compatible.js';
import { createLLMRouter } from './router.js';
import { AIError, ERROR_KINDS } from './errors.js';

/**
 * Default fallback order: fast models first, each step on a separate free quota.
 * Several Gemini versions are listed on purpose: each version has its own rate limit
 * and its own load, so when one returns 503 "high demand" another usually answers in 1-4 s.
 * Targets whose provider has no key are skipped automatically; retired models (404)
 * are parked for 6 hours and reported by `order-bot doctor`.
 */
export const DEFAULT_CHAIN = [
  'gemini:gemini-flash-latest',
  'gemini:gemini-3.6-flash',
  'gemini:gemini-3.5-flash',
  'gemini:gemini-3-flash-preview',
  'gemini:gemini-flash-lite-latest',
  'gemini:gemma-4-31b-it',
  'groq:llama-3.3-70b-versatile',
  'nvidia:nvidia/nemotron-3.5-lightning-30b-a3b',
  'openrouter:openrouter/free',
  'ollama:llama3.2',
];

/** "provider:model" (model may itself contain ":" or "/") -> { provider, model } */
export function parseChain(spec) {
  const list = Array.isArray(spec) ? spec : String(spec || '').split(/[,\n]/);
  return list
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      if (i <= 0 || i === s.length - 1) throw new Error(`Invalid AI_CHAIN entry "${s}" (expected provider:model)`);
      return { provider: s.slice(0, i).trim().toLowerCase(), model: s.slice(i + 1).trim() };
    });
}

export function createProvidersFromEnv(env = process.env, { fetchImpl = fetch } = {}) {
  const providers = {
    gemini: createGeminiProvider({ apiKey: env.GEMINI_API_KEY, fetchImpl }),
    nvidia: createOpenAICompatibleProvider({ name: 'nvidia', apiKey: env.NVIDIA_API_KEY, baseURL: PRESETS.nvidia.baseURL, fetchImpl }),
    openrouter: createOpenAICompatibleProvider({
      name: 'openrouter',
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: PRESETS.openrouter.baseURL,
      headers: { 'HTTP-Referer': env.OPENROUTER_SITE_URL || 'https://github.com/plari6', 'X-Title': env.OPENROUTER_APP_NAME || 'E-Commerce Order Status Bot' },
      fetchImpl,
    }),
    groq: createOpenAICompatibleProvider({ name: 'groq', apiKey: env.GROQ_API_KEY, baseURL: PRESETS.groq.baseURL, fetchImpl }),
    ollama: createOpenAICompatibleProvider({
      name: 'ollama',
      baseURL: env.OLLAMA_BASE_URL || PRESETS.ollama.baseURL,
      requiresKey: false,
      fetchImpl,
    }),
  };
  // Ollama runs locally; only use it when explicitly configured.
  if (!env.OLLAMA_BASE_URL) Object.assign(providers.ollama, { configured: false, disabledReason: 'set OLLAMA_BASE_URL to enable' });
  return providers;
}

/**
 * Wrap providers so named ones fail with 503 - used by `--simulate-outage` to demo the fallback
 * without waiting for a real outage.
 */
export function simulateOutage(providers, names = []) {
  const down = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  if (!down.size) return providers;
  const out = {};
  for (const [key, p] of Object.entries(providers)) {
    out[key] = !down.has(key)
      ? p
      : {
          ...p,
          async complete({ model }) {
            await new Promise((r) => setTimeout(r, 150));
            throw new AIError(`${key} 503: model is overloaded (simulated)`, { kind: ERROR_KINDS.overloaded, status: 503, provider: key, model });
          },
        };
  }
  return out;
}

export function createRouterFromEnv(env = process.env, { fetchImpl = fetch, onEvent, simulate = [], providers } = {}) {
  const chain = parseChain(env.AI_CHAIN || DEFAULT_CHAIN);
  const all = simulateOutage(providers || createProvidersFromEnv(env, { fetchImpl }), simulate);
  return createLLMRouter({
    chain,
    providers: all,
    timeoutMs: Number(env.AI_TIMEOUT_MS) || 10_000,
    totalBudgetMs: Number(env.AI_TOTAL_BUDGET_MS) || 30_000,
    hedgeAfterMs: env.AI_HEDGE_MS === undefined || env.AI_HEDGE_MS === '' ? 6_000 : Number(env.AI_HEDGE_MS) || 0,
    onEvent,
  });
}
