'use strict';

// utils/gemini.js — Google Gemini as a second AI provider (free tier via aistudio.google.com).
//
// Same contract as utils/api.js (Claude): timeouts, retries for 429/5xx, plain-English
// errors with the same codes the UI already acts on, and refusal/truncation handling.
// Google retires model versions often, so the model is not hard-coded: on Test we ask
// the API which models this key can use and pick the newest "flash" model.

const Gemini = (() => {
  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const FALLBACK_MODEL = 'gemini-2.5-flash';

  // Pasted keys often carry invisible characters, spaces or quotes; strip them.
  function cleanKey(key) {
    return String(key || '').replace(/[\s\u200B-\u200D\u2060\uFEFF"'`“”‘’]/g, '');
  }

  // Anthropic keys always start with "sk-ant-". Anything else is treated as a Google
  // Gemini key (usually "AIza…", but Google can change the format).
  function isGeminiKey(key) {
    const k = cleanKey(key);
    return !!k && !/^sk-ant-/i.test(k);
  }

  function label(model) {
    const m = /gemini-([\d.]+)-(flash|pro)(-lite)?/i.exec(model || '');
    return m ? `Gemini ${m[1]} ${m[2] === 'pro' ? 'Pro' : 'Flash'}${m[3] ? '-Lite' : ''}` : (model || 'Gemini');
  }

  async function request(apiKey, path, { method = 'POST', body, timeoutMs = 60000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Claude.ApiError(`Gemini took longer than ${Math.round(timeoutMs / 1000)}s. Please try again.`, { code: 'timeout' });
      throw new Claude.ApiError("Couldn't reach Google. Check your internet connection.", { code: 'network', retryable: true });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (res.ok && data) return data;
    if (res.ok) throw new Claude.ApiError('Gemini sent an unexpected response. Retrying…', { code: 'bad_response', retryable: true });
    throw classify(res.status, data?.error?.status, data?.error?.message || '');
  }

  function classify(status, gStatus, msg) {
    const E = Claude.ApiError;
    if (/api key not valid|api_key_invalid|invalid api key/i.test(msg) || status === 401) {
      return new E('Google rejected your Gemini API key. Check it in Settings.', { code: 'auth', status });
    }
    // Google can refuse free-tier use for a key's Cloud project (existing projects,
    // work/school accounts, some regions). Say what to do instead of pasting the raw text.
    if (/free tier is not available|billing to upgrade|project-unavailable|billing account/i.test(msg)) {
      return new E('Google won’t allow free-tier Gemini for this key’s project. Create a key in a new project from a personal Google account at aistudio.google.com, or use free mode.', { code: 'billing', status });
    }
    if (status === 403 || gStatus === 'PERMISSION_DENIED') {
      return new E(msg || 'This Gemini key isn’t allowed to use that model.', { code: 'permission', status });
    }
    if (status === 404 || gStatus === 'NOT_FOUND') {
      return new E('That Gemini model isn’t available to your key. Press Test in Settings to pick one again.', { code: 'model', status });
    }
    if (status === 429 || gStatus === 'RESOURCE_EXHAUSTED') {
      const daily = /per day|daily|quota exceeded.*day/i.test(msg);
      return new E(daily ? 'You’ve used today’s free Gemini quota. It resets tomorrow, or use free mode.' : 'Gemini’s free-tier rate limit was hit. Wait a minute and try again, or switch Research to Quick (fewer requests).',
        { code: 'rate_limit', status, retryable: !daily, retryAfter: 6 });
    }
    if (status >= 500 || gStatus === 'UNAVAILABLE') {
      return new E('Gemini is overloaded right now. Please try again in a moment.', { code: 'overloaded', status, retryable: true, retryAfter: 2 });
    }
    return new E(msg || `Gemini request failed (HTTP ${status}).`, { code: 'bad_request', status });
  }

  async function withRetries(fn, { retries = 2, onRetry } = {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (err) {
        if (!err.retryable || attempt >= retries) throw err;
        if (onRetry) { try { onRetry(attempt + 1, err); } catch (_) { /* ignore */ } }
        await new Promise(r => setTimeout(r, (err.retryAfter || 1.5 * 2 ** attempt) * 1000));
      }
    }
  }

  /**
   * generateContent.
   * @param {{model:string, system:string, text:string, pdfBase64?:string, search?:boolean, maxTokens?:number}} req
   */
  async function generate(apiKey, req, { timeoutMs = 60000, retries = 2, onRetry } = {}) {
    if (!apiKey) throw new Claude.ApiError('Add an API key in Settings to use AI mode.', { code: 'no_key' });
    const parts = [];
    if (req.pdfBase64) parts.push({ inline_data: { mime_type: 'application/pdf', data: req.pdfBase64 } });
    parts.push({ text: req.text });
    const body = {
      system_instruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: req.maxTokens || 8192 }
    };
    if (req.search) body.tools = [{ google_search: {} }];
    const model = req.model || FALLBACK_MODEL;
    return withRetries(() => request(apiKey, `/models/${encodeURIComponent(model)}:generateContent`, { body, timeoutMs }), { retries, onRetry });
  }

  /** Final text, after checking for blocks and truncation. */
  function textOf(data) {
    const E = Claude.ApiError;
    if (data?.promptFeedback?.blockReason) throw new E('Gemini declined this request. Try different context, or use free mode.', { code: 'refusal' });
    const c = data?.candidates?.[0];
    if (!c) throw new E('Gemini returned no answer. Please try again.', { code: 'bad_response' });
    const text = (c.content?.parts || []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
    if (!text && /SAFETY|BLOCKLIST|PROHIBITED|RECITATION/.test(c.finishReason || '')) {
      throw new E('Gemini declined to write this one. Try different context, or use free mode.', { code: 'refusal' });
    }
    if (!text && c.finishReason === 'MAX_TOKENS') throw new E('Gemini ran out of room before finishing. Please try again.', { code: 'truncated' });
    return text;
  }

  /** Web sources Gemini actually used when grounding with Google Search. */
  function sourcesOf(data) {
    const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    return chunks.map(ch => ch.web).filter(w => w && w.uri).map(w => ({ uri: w.uri, title: w.title || '' }));
  }

  function searchCount(data) {
    return (data?.candidates?.[0]?.groundingMetadata?.webSearchQueries || []).length;
  }

  /**
   * Models to try, best first: stable Flash (newest first), then stable Flash-Lite.
   * The newest model is often overloaded or limited on the free tier, so callers
   * walk this list instead of trusting the first entry.
   */
  async function rankModels(apiKey) {
    const data = await request(apiKey, '/models?pageSize=200', { method: 'GET', timeoutMs: 20000 });
    const usable = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(n => /^gemini-/.test(n) && !/tts|image|embedding|live|audio|vision|learnlm/i.test(n));
    const version = (n) => parseFloat((/gemini-([\d.]+)/.exec(n) || [])[1] || '0');
    const byVersion = (a, b) => version(b) - version(a);
    const flash = usable.filter(n => /^gemini-[\d.]+-flash$/.test(n)).sort(byVersion);
    const lite = usable.filter(n => /^gemini-[\d.]+-flash-lite$/.test(n)).sort(byVersion);
    const ranked = [...flash, ...lite];
    if (!ranked.length) ranked.push(...usable.filter(n => /flash/.test(n)).sort(byVersion));
    if (!ranked.includes(FALLBACK_MODEL) && usable.includes(FALLBACK_MODEL)) ranked.push(FALLBACK_MODEL);
    return ranked.length ? ranked.slice(0, 6) : [FALLBACK_MODEL];
  }

  /** Pick the newest stable "flash" model this key can call; fall back sensibly. */
  async function pickModel(apiKey) {
    const data = await request(apiKey, '/models?pageSize=200', { method: 'GET', timeoutMs: 20000 });
    const usable = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(n => /^gemini-/.test(n) && !/tts|image|embedding|live|audio|vision|learnlm/i.test(n));
    const version = (n) => parseFloat((/gemini-([\d.]+)/.exec(n) || [])[1] || '0');
    const stable = usable.filter(n => /^gemini-[\d.]+-flash$/.test(n)).sort((a, b) => version(b) - version(a));
    if (stable.length) return stable[0];
    const anyFlash = usable.filter(n => /flash/.test(n) && !/lite/.test(n)).sort((a, b) => version(b) - version(a));
    return anyFlash[0] || usable[0] || FALLBACK_MODEL;
  }

  // Errors worth trying the next model for (the key itself is fine).
  const TRY_NEXT = new Set(['overloaded', 'model', 'permission', 'rate_limit', 'timeout', 'bad_response']);

  return { generate, textOf, sourcesOf, searchCount, pickModel, rankModels, TRY_NEXT, isGeminiKey, cleanKey, label, API_BASE, FALLBACK_MODEL };
})();

if (typeof module !== 'undefined') module.exports = Gemini;
