'use strict';

// utils/api.js — the one place that talks to the Ark server.
//
// Every call gets a timeout, a safe JSON parse (Railway returns HTML error pages
// on cold starts / 502s), bounded retries for transient failures, and errors that
// carry a `code` the UI can act on instead of raw exception text.

const API = (() => {
  const SERVER_URL = 'https://linkedin-extention-production.up.railway.app';

  class ApiError extends Error {
    constructor(message, { code = 'unknown', status = 0, retryable = false } = {}) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
      this.retryable = retryable;
    }
  }

  /**
   * POST JSON to the server.
   * @param {string} path
   * @param {object} body
   * @param {{timeoutMs?:number, retries?:number, expectSuccess?:boolean, onRetry?:(attempt:number, err:ApiError)=>void}} opts
   */
  async function post(path, body, { timeoutMs = 45000, retries = 2, expectSuccess = false, onRetry } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await once(path, body, timeoutMs);
        if (expectSuccess && data.success === false) {
          throw classify(data.error || data.reason || 'The server could not complete this request.', 200);
        }
        return data;
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError(err.message || String(err));
        if (!e.retryable || attempt >= retries) throw e;
        if (onRetry) { try { onRetry(attempt + 1, e); } catch (_) { /* ignore */ } }
        await sleep(1200 * 2 ** attempt);
      }
    }
  }

  async function once(path, body, timeoutMs) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(SERVER_URL + path, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  ctrl.signal
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        // Not retried: the server may still be generating, and a retry would spend another credit.
        throw new ApiError(`The server took longer than ${Math.round(timeoutMs / 1000)}s to respond. Please try again.`, { code: 'timeout' });
      }
      throw new ApiError("Couldn't reach the server. Check your internet connection.", { code: 'network', retryable: true });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = null; }

    if (res.ok && data && typeof data === 'object') return data;

    const serverMsg = data && (data.error || data.reason || data.message);
    if (res.ok) {
      throw new ApiError('The server sent an unexpected response. Retrying…', { code: 'bad_response', status: res.status, retryable: true });
    }
    throw classify(serverMsg, res.status);
  }

  // Map HTTP status + server text to a friendly, actionable error.
  function classify(serverMsg, status) {
    const msg = (serverMsg || '').toString();
    const has = (re) => re.test(msg);

    if (status === 401 || status === 403 || has(/invalid (license|key)|license.*(invalid|expired|revoked)|unauthori[sz]ed/i)) {
      return new ApiError(msg || 'Your license key was rejected. Check it in Settings.', { code: 'auth', status });
    }
    if (status === 402 || status === 429 || has(/limit|quota|exceeded|too many/i)) {
      return new ApiError(msg || "You've reached today's message limit. It resets tomorrow.", { code: 'quota', status });
    }
    if (status === 413) {
      return new ApiError('Request too large. Try a smaller resume PDF in Settings.', { code: 'too_large', status });
    }
    if (status >= 500) {
      return new ApiError(
        msg && msg.length < 160 ? `Server error: ${msg}` : `The server is having trouble (HTTP ${status}). Please try again in a minute.`,
        { code: 'server', status, retryable: true }
      );
    }
    return new ApiError(msg || `Request failed (HTTP ${status || '?'}).`, { code: status ? 'bad_request' : 'unknown', status });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { post, ApiError, SERVER_URL };
})();
