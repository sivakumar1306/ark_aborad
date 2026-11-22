'use strict';

// utils/api.js — the one place that talks to Claude (Anthropic Messages API).
//
// v3.1 removed the company server: messages are written locally for free, or by
// Claude with the user's OWN Anthropic API key. Raw fetch is used (as upstream does)
// because the extension ships unbundled; this module adds what upstream lacked:
// timeouts, retries for 429/5xx/529 that respect retry-after, refusal and truncation
// handling, plain-English errors with codes the UI can act on, and per-call cost.

const Claude = (() => {
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2023-06-01';

  // $ per million tokens (Claude API list prices; Haiku 5.5 rate is for prompts ≤ 100K tokens).
  const PRICES = {
    'claude-haiku-5-5':  { in: 0.10, out: 0.50 },
    'claude-sonnet-5-5': { in: 2.00, out: 10.00 }
  };
  const WEB_SEARCH_PRICE = 0.01; // $10 per 1,000 searches

  const MODELS = {
    'claude-haiku-5-5':  'Haiku 5.5',
    'claude-sonnet-5-5': 'Sonnet 5.5'
  };

  class ApiError extends Error {
    constructor(message, { code = 'unknown', status = 0, retryable = false, retryAfter = 0 } = {}) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
      this.retryable = retryable;
      this.retryAfter = retryAfter;
    }
  }

  /**
   * POST /v1/messages.
   * @param {string} apiKey  the user's own key (sk-ant-…)
   * @param {object} body    Messages API request body
   * @param {{timeoutMs?:number, retries?:number, betas?:string[], onRetry?:(attempt:number, err:ApiError)=>void}} opts
   */
  async function create(apiKey, body, { timeoutMs = 60000, retries = 2, betas = [], onRetry } = {}) {
    if (!apiKey) throw new ApiError('Add your Anthropic API key in Settings to use AI mode.', { code: 'no_key' });
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(apiKey, body, timeoutMs, betas);
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError(err.message || String(err));
        if (!e.retryable || attempt >= retries) throw e;
        if (onRetry) { try { onRetry(attempt + 1, e); } catch (_) { /* ignore */ } }
        const wait = e.retryAfter ? Math.min(20, e.retryAfter) * 1000 : 1500 * 2 ** attempt;
        await sleep(wait);
      }
    }
  }

  async function once(apiKey, body, timeoutMs, betas) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (betas.length) headers['anthropic-beta'] = betas.join(',');

    let res;
    try {
      res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ApiError(`Claude took longer than ${Math.round(timeoutMs / 1000)}s. Please try again.`, { code: 'timeout' });
      }
      throw new ApiError("Couldn't reach Anthropic. Check your internet connection.", { code: 'network', retryable: true });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

    if (res.ok && data) return data;
    if (res.ok) throw new ApiError('Anthropic sent an unexpected response. Retrying…', { code: 'bad_response', status: res.status, retryable: true });
    throw classify(res.status, data?.error?.type, data?.error?.message, Number(res.headers.get('retry-after')) || 0);
  }

  function classify(status, type, message = '', retryAfter = 0) {
    const msg = String(message || '');
    if (status === 401 || type === 'authentication_error') {
      return new ApiError('Anthropic rejected your API key. Check it in Settings.', { code: 'auth', status });
    }
    if (status === 402 || type === 'billing_error' || /credit balance/i.test(msg)) {
      return new ApiError('Your Anthropic credit balance is too low. Add credits at console.anthropic.com, or use free mode.', { code: 'billing', status });
    }
    if (status === 403 || type === 'permission_error') {
      return new ApiError(msg || 'This API key isn’t allowed to use this model.', { code: 'permission', status });
    }
    if (status === 404 || type === 'not_found_error') {
      return new ApiError('That Claude model isn’t available to your API key. Pick another model in Settings.', { code: 'model', status });
    }
    if (status === 413 || type === 'request_too_large') {
      return new ApiError('Request too large. Try a smaller resume PDF in Settings.', { code: 'too_large', status });
    }
    if (status === 429 || type === 'rate_limit_error') {
      const spendCap = /spend|monthly|usage limit/i.test(msg);
      return new ApiError(spendCap ? `Your API key hit its spend limit: ${msg}` : 'Rate limited by Anthropic. Retrying shortly…',
        { code: 'rate_limit', status, retryable: !spendCap, retryAfter });
    }
    if (status === 529 || type === 'overloaded_error' || status >= 500) {
      return new ApiError('Anthropic is overloaded right now. Please try again in a moment.', { code: 'overloaded', status, retryable: true, retryAfter });
    }
    return new ApiError(msg || `Request failed (HTTP ${status}).`, { code: 'bad_request', status });
  }

  /** Text of the final answer, after checking stop_reason. */
  function textOf(data) {
    if (data?.stop_reason === 'refusal') {
      throw new ApiError('Claude declined to write this one. Try different context, or use free mode.', { code: 'refusal' });
    }
    const text = (data?.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
    if (!text && data?.stop_reason === 'max_tokens') {
      throw new ApiError('Claude ran out of room before finishing. Please try again.', { code: 'truncated' });
    }
    return text;
  }

  /** Dollar cost of one response, from its usage block. */
  function cost(model, usage = {}) {
    const p = PRICES[model];
    if (!p) return 0;
    const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
    const searches = usage.server_tool_use?.web_search_requests || 0;
    return (input * p.in + (usage.output_tokens || 0) * p.out) / 1e6 + searches * WEB_SEARCH_PRICE;
  }

  function formatCost(dollars) {
    if (!dollars) return '$0';
    if (dollars < 0.001) return '<$0.001';
    if (dollars < 0.1) return `$${dollars.toFixed(3)}`;
    return `$${dollars.toFixed(2)}`;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { create, textOf, cost, formatCost, ApiError, MODELS, API_URL };
})();

if (typeof module !== 'undefined') module.exports = Claude;
