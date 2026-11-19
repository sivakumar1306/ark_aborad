'use strict';

// utils/session.js — per-profile working state, kept in chrome.storage.session.
//
// The background worker owns all writes; the side panel only reads and re-renders
// on storage changes. That is what lets a 20-second Deep Mode run survive the panel
// closing, the user switching tabs, or navigating away and back.

const Sessions = (() => {
  const PREFIX   = 'sess:';
  const MAX_KEPT = 25;
  const BUSY     = new Set(['reading', 'researching', 'writing']);

  function keyFromUrl(url) {
    const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url || '');
    if (!m) return null;
    try { return decodeURIComponent(m[1]).toLowerCase(); } catch (_) { return m[1].toLowerCase(); }
  }

  function blank(key) {
    return {
      key,
      profileUrl:     null,
      profile:        null,     // raw scrape
      loadingProfile: false,
      profileError:   null,
      edits:          {},       // user corrections to the scrape
      context:        '',       // optional free-text context for this person
      mode:           'quick',
      stage:          'idle',   // idle | reading | researching | writing | done | error
      steps:          { read: 'idle', research: 'skip', write: 'idle' },
      research:       null,     // { profileJSON, enrichmentJSON } from Deep Mode
      hooks:          [],       // [{ text, selected }]
      versions:       [],       // [{ id, text, format, purpose, tone, mode, createdAt }]
      active:         -1,
      error:          null,
      errorCode:      null,
      notice:         null,
      updatedAt:      Date.now()
    };
  }

  async function get(key) {
    if (!key) return null;
    const k = PREFIX + key;
    const r = await chrome.storage.session.get(k);
    return r[k] || null;
  }

  // Serialised read-modify-write per key, so overlapping updates never clobber each other.
  const chains = new Map();
  function update(key, mutate) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(async () => {
      const cur  = (await get(key)) || blank(key);
      const out  = mutate(cur) || cur;
      out.updatedAt = Date.now();
      await chrome.storage.session.set({ [PREFIX + key]: out });
      return out;
    });
    chains.set(key, next.catch(() => {}));
    return next;
  }

  async function all() {
    const everything = await chrome.storage.session.get(null);
    return Object.entries(everything)
      .filter(([k]) => k.startsWith(PREFIX))
      .map(([, v]) => v);
  }

  async function prune() {
    const list = await all();
    if (list.length <= MAX_KEPT) return;
    const drop = list.sort((a, b) => b.updatedAt - a.updatedAt).slice(MAX_KEPT);
    await chrome.storage.session.remove(drop.map(s => PREFIX + s.key));
  }

  function isBusy(s) { return !!s && BUSY.has(s.stage); }

  // Scraped data with the user's corrections applied.
  function effectiveProfile(s) {
    if (!s || !s.profile) return null;
    const out = { ...s.profile };
    for (const [k, v] of Object.entries(s.edits || {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) ? v.length : String(v).trim()) out[k] = v;
    }
    return out;
  }

  return { PREFIX, keyFromUrl, blank, get, update, all, prune, isBusy, effectiveProfile };
})();
