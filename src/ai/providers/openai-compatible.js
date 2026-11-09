import { AIError, ERROR_KINDS, fetchFailure, kindFromStatus, parseRetryAfter, readBody, shortMessage } from '../errors.js';

/** Known OpenAI-compatible endpoints. Any other can be added with createOpenAICompatibleProvider. */
export const PRESETS = {
  nvidia: { baseURL: 'https://integrate.api.nvidia.com/v1', keyEnv: 'NVIDIA_API_KEY' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  ollama: { baseURL: 'http://localhost:11434/v1', keyEnv: null, baseEnv: 'OLLAMA_BASE_URL' },
};

/**
 * One client for every OpenAI-compatible chat API (NVIDIA NIM, OpenRouter, Groq,
 * Ollama, Together, vLLM...). Uses fetch directly - no `openai` SDK required.
 */
export function createOpenAICompatibleProvider({ name, apiKey, baseURL, headers = {}, requiresKey = true, jsonMode = false, fetchImpl = fetch } = {}) {
  if (!name || !baseURL) throw new Error('createOpenAICompatibleProvider needs name and baseURL');
  const root = baseURL.replace(/\/+$/, '');
  return {
    name,
    configured: !requiresKey || Boolean(apiKey),
    async complete({ model, system, messages, json = false, temperature = 0.2, maxTokens = 1024, signal, timeoutMs = 15000 }) {
      if (requiresKey && !apiKey) throw new AIError(`${name} API key is not set`, { kind: ERROR_KINDS.auth, provider: name, model });
      const body = {
        model,
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map((m) => ({ role: m.role, content: m.content }))],
        temperature,
        max_tokens: maxTokens,
        stream: false,
        // Not every hosted model supports response_format, so it is opt-in per provider.
        ...(json && jsonMode ? { response_format: { type: 'json_object' } } : {}),
      };

      const timeout = AbortSignal.timeout(timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${root}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        throw fetchFailure(err, { provider: name, model, callerSignal: signal });
      }

      let payload;
      try {
        payload = await readBody(res);
      } catch (err) {
        throw fetchFailure(err, { provider: name, model, callerSignal: signal });
      }
      // OpenRouter can answer 200 with an { error } body when the upstream model fails.
      const embedded = payload.json?.error;
      if (!res.ok || embedded) {
        const status = res.ok ? Number(embedded?.code) || 502 : res.status;
        const msg = shortMessage(payload.json, payload.text);
        throw new AIError(`${name} ${status}: ${msg}`, {
          kind: kindFromStatus(status, payload.text),
          status,
          retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after'), payload.json),
          provider: name,
          model,
        });
      }
      const choice = payload.json.choices?.[0];
      const content = choice?.message?.content;
      const text = (Array.isArray(content) ? content.map((c) => c.text || '').join('') : content || '').trim();
      if (!text) {
        throw new AIError(`${name} returned no text (${choice?.finish_reason || 'empty response'})`, { kind: ERROR_KINDS.bad_output, provider: name, model });
      }
      const u = payload.json.usage || {};
      return { text, usage: { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }, servedBy: payload.json.model };
    },
  };
}
