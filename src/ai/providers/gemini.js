import { AIError, ERROR_KINDS, fetchFailure, kindFromStatus, parseRetryAfter, readBody, shortMessage } from '../errors.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Google Gemini (and Gemma) over plain REST - no SDK needed.
 * Gemma models on the Gemini API reject systemInstruction and JSON mode, so for
 * them the system prompt is folded into the first user turn.
 */
export function createGeminiProvider({ apiKey, baseURL = DEFAULT_BASE, fetchImpl = fetch } = {}) {
  const name = 'gemini';
  return {
    name,
    configured: Boolean(apiKey),
    async complete({ model, system, messages, json = false, temperature = 0.2, maxTokens = 1024, signal, timeoutMs = 15000 }) {
      if (!apiKey) throw new AIError('GEMINI_API_KEY is not set', { kind: ERROR_KINDS.auth, provider: name, model });
      const isGemma = /^gemma/i.test(model);
      const contents = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      if (isGemma && system) {
        const first = contents.find((c) => c.role === 'user');
        if (first) first.parts[0].text = `${system}\n\n---\n\n${first.parts[0].text}`;
        else contents.unshift({ role: 'user', parts: [{ text: system }] });
      }
      const body = {
        contents,
        generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json && !isGemma ? { responseMimeType: 'application/json' } : {}) },
        ...(system && !isGemma ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      };

      const timeout = AbortSignal.timeout(timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${baseURL}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
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
      if (!res.ok) {
        const msg = shortMessage(payload.json, payload.text);
        throw new AIError(`gemini ${res.status}: ${msg}`, {
          kind: kindFromStatus(res.status, payload.text),
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after'), payload.json),
          provider: name,
          model,
        });
      }
      const candidate = payload.json.candidates?.[0];
      const text = (candidate?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
      if (!text) {
        const reason = candidate?.finishReason || payload.json.promptFeedback?.blockReason || 'empty response';
        throw new AIError(`gemini returned no text (${reason})`, { kind: ERROR_KINDS.bad_output, provider: name, model });
      }
      const u = payload.json.usageMetadata || {};
      return { text, usage: { inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount } };
    },
  };
}
