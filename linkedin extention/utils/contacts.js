'use strict';

// utils/contacts.js — lightweight outreach tracker (was: last-5 "recent" cache).
//
// One entry per person, keyed by LinkedIn slug (the old cache keyed by profileUrl,
// so entries with an empty URL silently overwrote each other). Tracks status
// (drafted → sent → replied) and when to follow up.
// Writes happen in the background worker only; the panel asks it via messages.

const ContactStore = (() => {
  const KEY    = 'contacts';
  const LEGACY = 'recentContacts';
  const MAX    = 50;
  const DAY    = 24 * 60 * 60 * 1000;

  function idOf(c) {
    return Sessions.keyFromUrl(c.profileUrl) || ('name:' + (c.name || 'unknown').toLowerCase().trim());
  }

  async function list() {
    const r = await chrome.storage.local.get([KEY, LEGACY]);
    if (Array.isArray(r[KEY])) return r[KEY];
    // One-time migration from v3 "recentContacts".
    const migrated = (r[LEGACY] || []).map(c => ({
      ...c, id: idOf(c), status: 'drafted', createdAt: c.timestamp || Date.now(), updatedAt: c.timestamp || Date.now()
    }));
    await chrome.storage.local.set({ [KEY]: migrated });
    await chrome.storage.local.remove(LEGACY);
    return migrated;
  }

  async function save(items) {
    await chrome.storage.local.set({ [KEY]: items.slice(0, MAX) });
  }

  async function upsert(contact) {
    const items = await list();
    const id = idOf(contact);
    const i = items.findIndex(x => x.id === id);
    const prev = i >= 0 ? items.splice(i, 1)[0] : null;
    const merged = {
      status: 'drafted', createdAt: Date.now(),
      ...prev, ...contact,
      id, updatedAt: Date.now(), timestamp: Date.now()
    };
    if (prev && prev.status) merged.status = prev.status; // new draft doesn't undo "sent"
    items.unshift(merged);
    await save(items);
    return merged;
  }

  async function setStatus(id, status, followUpDays = 5) {
    const items = await list();
    const c = items.find(x => x.id === id);
    if (!c) return null;
    const now = Date.now();
    c.status = status;
    c.updatedAt = now;
    if (status === 'sent') {
      c.sentAt = now;
      c.followUpAt = followUpDays > 0 ? now + followUpDays * DAY : null;
      c.notified = false;
    } else if (status === 'replied') {
      c.repliedAt = now;
      c.followUpAt = null;
    } else {
      c.sentAt = null; c.followUpAt = null; c.notified = false;
    }
    await save(items);
    return c;
  }

  async function patch(ids, fields) {
    const items = await list();
    items.forEach(c => { if (ids.includes(c.id)) Object.assign(c, fields); });
    await save(items);
  }

  async function remove(id) { await save((await list()).filter(c => c.id !== id)); }
  async function clear()    { await save([]); }

  function isDue(c, now = Date.now()) {
    return c.status === 'sent' && c.followUpAt && c.followUpAt <= now;
  }

  function toCSV(items) {
    const cols = ['name', 'headline', 'company', 'profileUrl', 'status', 'format', 'createdAt', 'sentAt', 'followUpAt', 'message'];
    const cell = (v) => (v === undefined || v === null ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const fmt = (k, v) => (/At$/.test(k) && v ? new Date(v).toISOString() : v);
    return [cols.join(','), ...items.map(c => cols.map(k => cell(fmt(k, c[k]))).join(','))].join('\r\n');
  }

  return { KEY, list, upsert, setStatus, patch, remove, clear, isDue, toCSV, idOf, DAY };
})();
