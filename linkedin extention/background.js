'use strict';

// background.js — the extension's engine.
//
// Runs every scrape → research → write job and records progress in
// chrome.storage.session (see utils/session.js). The side panel is a pure view of
// that state, so closing it mid-run loses nothing. All AI happens server-side;
// the extension only sends profile data + the license key.

importScripts('utils/api.js', 'utils/session.js', 'utils/formats.js', 'utils/contacts.js');

const FOLLOWUP_ALARM = 'ark-followups';
const SETTINGS_KEYS  = ['licenseKey', 'userName', 'userBio', 'resumeBase64', 'license', 'noteLimit', 'followUpDays'];

// ─── Lifecycle ────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  setup();
  chrome.contextMenus.create({
    id: 'ark-write',
    title: 'Write outreach message for this profile',
    contexts: ['page'],
    documentUrlPatterns: ['https://www.linkedin.com/in/*']
  }, () => void chrome.runtime.lastError);
});
chrome.runtime.onStartup.addListener(setup);

function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.get(FOLLOWUP_ALARM, (a) => {
    if (!a) chrome.alarms.create(FOLLOWUP_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
  });
  refreshBadge();
}

// A worker restart means any in-flight job died with it; don't leave spinners forever.
(async () => {
  for (const s of await Sessions.all()) {
    if (Sessions.isBusy(s)) {
      await Sessions.update(s.key, x => failSteps(x, 'Interrupted — Chrome restarted the extension. Please try again.', 'interrupted'));
    }
  }
})();

// ─── Entry points that must open the panel inside the user gesture ───────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ark-write' && tab) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-panel' && tab) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

// ─── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'OPEN_PANEL' && sender.tab) {
    // Must be called synchronously to keep the user-gesture from the in-page button.
    chrome.sidePanel.open({ windowId: sender.tab.windowId })
      .then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(r => sendResponse({ ok: true, ...(r || {}) }), e => sendResponse({ ok: false, error: e.message, code: e.code }));
  return true;
});

const HANDLERS = {
  SCRAPE:          (m) => scrapeIntoSession(m),
  GENERATE:        (m) => runJob(m.key, () => jobGenerate(m)),
  WRITE:           (m) => runJob(m.key, () => jobWrite(m)),
  PATCH_SESSION:   (m) => patchSession(m),
  VALIDATE_KEY:    (m) => validateKey(m.key),
  INSERT:          (m) => insertIntoPage(m),
  CONTACT_STATUS:  async (m) => { const s = await getSettings(); const c = await ContactStore.setStatus(m.id, m.status, s.followUpDays ?? 5); refreshBadge(); return { contact: c }; },
  CONTACT_DELETE:  async (m) => { await ContactStore.remove(m.id); refreshBadge(); },
  CONTACTS_CLEAR:  async ()  => { await ContactStore.clear(); refreshBadge(); }
};

// ─── Jobs ─────────────────────────────────────────────────────────────────────
const running = new Set();

function runJob(key, fn) {
  if (!key) throw new Error('Open a LinkedIn profile first.');
  if (running.has(key)) return { busy: true };
  running.add(key);
  const stopKeepAlive = keepAlive();
  fn()
    .catch(err => {
      if (err.code === 'auth')  setLicense({ status: 'invalid', reason: err.message });
      if (err.code === 'quota') setLicense({ remaining: 0 });
      return Sessions.update(key, s => failSteps(s, err.message, err.code));
    })
    .finally(() => { running.delete(key); stopKeepAlive(); });
  Sessions.prune().catch(() => {});
  return { started: true };
}

// Extension API calls reset the worker's idle timer; long fetches otherwise risk termination.
function keepAlive() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  return () => clearInterval(t);
}

async function jobGenerate({ tabId, key, mode, options }) {
  const settings = await requireKey();
  const deep = mode === 'deep';

  await Sessions.update(key, s => {
    s.mode = mode;
    s.stage = 'reading';
    s.error = s.errorCode = null;
    s.notice = null;
    s.startedAt = Date.now();
    s.steps = { read: 'running', research: deep ? 'pending' : 'skip', write: 'pending' };
    if (deep) { s.research = null; s.hooks = []; }
    return s;
  });

  let s = await Sessions.get(key);
  if (!s.profile?.full || options?.refresh) {
    const profile = await scrapeTab(tabId, { full: true, expectKey: key });
    s = await Sessions.update(key, x => { x.profile = profile; x.profileUrl = profile.profileUrl; x.profileError = null; return x; });
  }
  await Sessions.update(key, x => { x.steps.read = 'done'; return x; });

  if (deep) {
    await Sessions.update(key, x => { x.stage = 'researching'; x.steps.research = 'running'; x.notice = 'Searching company news and public work — usually ~20s'; return x; });
    const r = await API.post('/api/generate/enrich', {
      key: settings.licenseKey,
      rawProfileData: Sessions.effectiveProfile(s)
    }, { timeoutMs: 120000, retries: 1, expectSuccess: true, onRetry: retryNotice(key) });

    await Sessions.update(key, x => {
      x.research = { profileJSON: r.profileJSON || {}, enrichmentJSON: r.enrichmentJSON || {} };
      x.hooks = extractHooks(r.enrichmentJSON).map((text, i) => ({ text, selected: i < 3 }));
      x.steps.research = 'done';
      x.notice = null;
      return x;
    });
  }

  await write(key, { ...options, mode }, settings);
}

async function jobWrite({ key, options }) {
  const settings = await requireKey();
  const s = await Sessions.get(key);
  if (!s?.profile) throw new Error('Read the profile first.');
  await write(key, options, settings);
}

async function write(key, options = {}, settings) {
  await Sessions.update(key, x => {
    // Coming straight from jobGenerate (write still 'pending') keeps the run's start time.
    if (!x.startedAt || x.steps?.write !== 'pending') x.startedAt = Date.now();
    x.stage = 'writing';
    x.error = x.errorCode = null;
    x.steps = {
      read: 'done',
      research: options.mode === 'deep' && x.research ? 'done' : 'skip',
      write: 'running'
    };
    return x;
  });

  const s       = await Sessions.get(key);
  const useDeep = options.mode === 'deep' && s.research;
  const current = s.versions[s.active];
  const hooks   = (s.hooks || []).filter(h => h.selected).map(h => h.text);

  const brief = Formats.brief({
    format:    options.format,
    context:   s.context,
    shorten:   options.shorten,
    previous:  options.shorten ? current?.text : null,
    noteLimit: settings.noteLimit || 300,
    hooks:     useDeep ? hooks.length : undefined
  });
  const f = Formats.get(options.format, { noteLimit: settings.noteLimit || 300 });

  const common = {
    key:          settings.licenseKey,
    messageType:  options.purpose || 'Networking',
    tone:         options.tone || 'Neutral',
    userName:     settings.userName || '',
    userBio:      [settings.userBio, `[Message requirements]\n${brief}`].filter(Boolean).join('\n\n'),
    resumeBase64: settings.resumeBase64 || null,
    // Forward-compatible fields (ignored by servers that don't know them yet):
    format:       f.id,
    maxChars:     f.limit || f.target,
    instructions: brief
  };

  let result;
  if (useDeep) {
    const profileJSON    = { ...s.research.profileJSON, ...nonEmpty(s.edits) };
    const enrichmentJSON = { ...s.research.enrichmentJSON, topHooks: hooks };
    result = await API.post('/api/generate/deep', { ...common, profileJSON, enrichmentJSON },
      { timeoutMs: 90000, retries: 1, expectSuccess: true, onRetry: retryNotice(key) });
  } else {
    result = await API.post('/api/generate/quick', { ...common, profileData: Sessions.effectiveProfile(s) },
      { timeoutMs: 60000, retries: 1, expectSuccess: true, onRetry: retryNotice(key) });
  }

  const text = String(result.message || '').trim();
  if (!text) throw new Error('The server returned an empty message. Please try again.');

  const done = await Sessions.update(key, x => {
    x.versions.push({
      id: Date.now().toString(36),
      text, format: f.id,
      purpose: common.messageType, tone: common.tone,
      mode: useDeep ? 'deep' : 'quick',
      hooks: useDeep ? hooks : [],
      createdAt: Date.now()
    });
    if (x.versions.length > 12) x.versions.shift();
    x.active = x.versions.length - 1;
    x.stage = 'done';
    x.steps.write = 'done';
    x.notice = `Written in ${Math.max(1, Math.round((Date.now() - (x.startedAt || Date.now())) / 1000))}s`;
    return x;
  });

  if (typeof result.remaining === 'number') await setLicense({ remaining: result.remaining, status: 'valid' });

  const p = Sessions.effectiveProfile(done) || {};
  await ContactStore.upsert({
    profileUrl: done.profileUrl || p.profileUrl || '',
    name:       p.name || 'Unknown',
    headline:   p.headline || '',
    company:    p.currentCompany || '',
    message:    text,
    format:     f.id
  });
}

function retryNotice(key) {
  return (attempt, err) => Sessions.update(key, x => {
    x.notice = err.code === 'network' ? `Connection hiccup — retrying (${attempt})…` : `Server is waking up — retrying (${attempt})…`;
    return x;
  });
}

function failSteps(s, message, code) {
  for (const k of Object.keys(s.steps || {})) {
    if (s.steps[k] === 'running') s.steps[k] = 'error';
    if (s.steps[k] === 'pending') s.steps[k] = 'idle';
  }
  s.stage = 'error';
  s.error = message;
  s.errorCode = code || null;
  s.notice = null;
  s.loadingProfile = false;
  return s;
}

function extractHooks(enrichment) {
  if (!enrichment) return [];
  const raw = Array.isArray(enrichment.topHooks) && enrichment.topHooks.length
    ? enrichment.topHooks
    : (enrichment.companyNews || []).map(n => n?.relevance || n?.headline);
  return [...new Set(raw.map(h => (typeof h === 'string' ? h : h?.text || h?.hook || '')).map(t => t.trim()).filter(Boolean))].slice(0, 6);
}

function nonEmpty(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => (Array.isArray(v) ? v.length : v && String(v).trim())));
}

// ─── Session patches from the panel (UI-owned fields only) ────────────────────
const PATCHABLE = ['edits', 'context', 'hooks', 'versions', 'active'];

async function patchSession({ key, patch }) {
  if (!key || !patch) return;
  await Sessions.update(key, s => {
    for (const k of PATCHABLE) if (k in patch) s[k] = patch[k];
    if ('versions' in patch && s.active >= s.versions.length) s.active = s.versions.length - 1;
    return s;
  });
}

// ─── Scraping ─────────────────────────────────────────────────────────────────
async function scrapeIntoSession({ tabId, key, light, force, delayMs }) {
  const existing = await Sessions.get(key);
  if (running.has(key) || existing?.loadingProfile) return { busy: true };
  if (existing?.profile && !force) return { cached: true };

  await Sessions.update(key, s => { s.loadingProfile = true; s.profileError = null; return s; });
  try {
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    const profile = await scrapeTab(tabId, { full: !light, expectKey: key });
    await Sessions.update(key, s => {
      s.profile = profile;
      s.profileUrl = profile.profileUrl;
      s.loadingProfile = false;
      if (force) s.edits = {};
      return s;
    });
    return { profile };
  } catch (err) {
    await Sessions.update(key, s => { s.loadingProfile = false; s.profileError = err.message; return s; });
    throw err;
  }
}

async function scrapeTab(tabId, opts) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('That tab was closed.');
  if (!Sessions.keyFromUrl(tab.url)) throw new Error('Open a LinkedIn profile (linkedin.com/in/…) first.');
  const res = await sendToTab(tabId, { action: 'scrapeProfile', ...opts });
  if (!res?.success) throw new Error(res?.error || "Couldn't read this profile. Try reloading the page.");
  return res.data;
}

// Send to the content script, injecting it first if the tab predates the install/update.
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_script.js'] });
    await new Promise(r => setTimeout(r, 250));
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

async function insertIntoPage({ tabId, text }) {
  const res = await sendToTab(tabId, { action: 'insertMessage', text });
  return { result: res || { success: false } };
}

// ─── License ──────────────────────────────────────────────────────────────────
async function validateKey(rawKey) {
  const key = (rawKey || '').trim().toUpperCase();
  if (!key) throw new Error('Enter a license key.');
  let license;
  try {
    const d = await API.post('/api/validate', { key }, { timeoutMs: 20000, retries: 1 });
    license = d.valid
      ? { status: 'valid', remaining: d.remaining, reason: null }
      : { status: 'invalid', reason: d.reason || 'That key isn’t valid.' };
  } catch (err) {
    license = { status: err.code === 'auth' ? 'invalid' : 'unknown', reason: err.message };
  }
  license = { ...license, key, checkedAt: Date.now() };
  const save = { license };
  if (license.status === 'valid') save.licenseKey = key;
  await chrome.storage.local.set(save);
  return { license };
}

async function setLicense(fields) {
  const { license = {}, licenseKey } = await chrome.storage.local.get(['license', 'licenseKey']);
  await chrome.storage.local.set({ license: { ...license, key: licenseKey, checkedAt: Date.now(), ...fields } });
}

async function getSettings() {
  return chrome.storage.local.get(SETTINGS_KEYS);
}

async function requireKey() {
  const s = await getSettings();
  if (!s.licenseKey) {
    const e = new Error('No license key yet. Add it in Settings.');
    e.code = 'no_key';
    throw e;
  }
  return s;
}

// ─── Follow-up reminders ──────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== FOLLOWUP_ALARM) return;
  const items = await ContactStore.list();
  const due = items.filter(c => ContactStore.isDue(c) && !c.notified);
  for (const c of due.slice(0, 3)) {
    const days = Math.max(1, Math.round((Date.now() - (c.sentAt || Date.now())) / ContactStore.DAY));
    chrome.notifications.create('fu:' + c.id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `Follow up with ${c.name}?`,
      message: `You messaged ${c.name.split(' ')[0]} ${days} day${days === 1 ? '' : 's'} ago and haven't marked a reply.`,
      priority: 1
    });
  }
  if (due.length) await ContactStore.patch(due.map(c => c.id), { notified: true });
  refreshBadge();
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('fu:')) return;
  const c = (await ContactStore.list()).find(x => x.id === id.slice(3));
  if (c?.profileUrl) chrome.tabs.create({ url: c.profileUrl });
  chrome.notifications.clear(id);
});

async function refreshBadge() {
  const due = (await ContactStore.list()).filter(c => ContactStore.isDue(c)).length;
  chrome.action.setBadgeText({ text: due ? String(due) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#B45309' });
}
