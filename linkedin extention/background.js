'use strict';

// background.js — the extension's engine.
//
// Runs every scrape → research → write job and records progress in
// chrome.storage.session (see utils/session.js). The side panel is a pure view of
// that state, so closing it mid-run loses nothing.
//
// Two writers: Free mode (utils/localwriter.js, on-device, no key) and AI mode
// (Claude with the user's own Anthropic API key, utils/api.js + utils/prompts.js).
// There is no company server and no license key.

importScripts('utils/api.js', 'utils/session.js', 'utils/formats.js', 'utils/contacts.js', 'utils/common.js',
  'utils/localwriter.js', 'utils/prompts.js', 'utils/recipient.js', 'utils/names.js');

const FOLLOWUP_ALARM = 'ark-followups';
const SETTINGS_KEYS  = ['userApiKey', 'keyStatus', 'writerModel', 'userName', 'userBio', 'resumeBase64', 'myProfile', 'noteLimit', 'followUpDays'];

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
  TEST_KEY:        (m) => testKey(m.key),
  INSERT:          (m) => insertIntoPage(m),
  IMPORT_ME:       (m) => importMyProfile(m),
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
      if (['auth', 'billing', 'permission'].includes(err.code)) setKeyStatus({ status: 'invalid', reason: err.message, code: err.code });
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
  const settings = await getSettings();
  const deep = mode === 'deep';
  const useAI = !!settings.userApiKey && !options?.forceLocal;

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
    const profile = Sessions.effectiveProfile(s);
    const local = LocalWriter.hooks(profile);
    if (useAI) {
      await Sessions.update(key, x => { x.stage = 'researching'; x.steps.research = 'running'; x.notice = `Searching the web for recent news about ${profile.currentCompany || profile.name}…`; return x; });
      const r = await Prompts.research(settings.userApiKey, profile, { onRetry: retryNotice(key) });
      // Web hooks first, then the strongest profile hooks (their posts).
      const hooks = [...r.hooks, ...local.filter(h => h.kind === 'post')].slice(0, 6);
      await Sessions.update(key, x => {
        x.research = { source: 'web', searches: r.searches, cost: r.cost, at: Date.now() };
        x.hooks = hooks.map((h, i) => ({ ...h, selected: i < 3 }));
        x.steps.research = 'done';
        x.notice = `${r.searches} search${r.searches === 1 ? '' : 'es'} · ${r.hooks.length} sourced hook${r.hooks.length === 1 ? '' : 's'} · ${Claude.formatCost(r.cost)}`;
        return x;
      });
    } else {
      await Sessions.update(key, x => {
        x.research = { source: 'profile', at: Date.now() };
        x.hooks = local.map((h, i) => ({ ...h, selected: i < 2 }));
        x.steps.research = 'done';
        return x;
      });
    }
  }

  const after = await Sessions.get(key);
  await write(key, { ...options, mode, researchCost: deep ? after.research?.cost || 0 : 0 }, settings);
}

async function jobWrite({ key, options }) {
  const settings = await getSettings();
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

  const s        = await Sessions.get(key);
  const useDeep  = options.mode === 'deep' && s.research;
  const current  = s.versions[s.active];
  const hooks    = useDeep ? (s.hooks || []).filter(h => h.selected) : [];
  const noteLimit = settings.noteLimit || 300;
  const f        = Formats.get(options.format, { noteLimit });
  const profile  = Sessions.effectiveProfile(s);
  const useAI    = !!settings.userApiKey && !options.forceLocal;
  const model    = settings.writerModel || 'claude-haiku-5-5';
  const recipient = Recipient.classify(profile);
  // "Auto" (or anything unknown) resolves to what fits this person.
  const purpose  = !options.purpose || options.purpose === 'Auto' ? Recipient.suggestPurpose(recipient) : options.purpose;

  let text, cost = 0, engine;
  if (useAI) {
    const requirements = Formats.brief({
      format:    options.format,
      context:   s.context,
      shorten:   options.shorten,
      previous:  options.shorten || options.revise ? (options.previous || current?.text) : null,
      noteLimit,
      hooks:     useDeep ? hooks.length : undefined,
      commonGround: options.commonGround,
      revise:    options.revise,
      recipient
    });
    const body = Prompts.writerBody({
      model, profile, hooks,
      common: options.commonGround,
      recipientType: recipient?.type,
      sender: { name: settings.userName, bio: settings.userBio, profile: settings.myProfile },
      purpose,
      tone: options.tone || 'Neutral',
      requirements,
      resumeBase64: settings.resumeBase64 || null
    });
    const data = await Claude.create(settings.userApiKey, body, { timeoutMs: 60000, retries: 2, betas: Prompts.betasFor(model), onRetry: retryNotice(key) });
    text = Claude.textOf(data);
    cost = Claude.cost(model, data.usage);
    engine = model;
    if (settings.keyStatus?.status !== 'valid') setKeyStatus({ status: 'valid' });
  } else {
    text = LocalWriter.write({
      profile,
      sender: { name: settings.userName, bio: settings.userBio },
      common: options.commonGround,
      hooks,
      purpose,
      tone: options.tone || 'Neutral',
      format: f.id,
      noteLimit,
      variant: s.versions.length,
      recipientType: recipient?.type,
      shorten: options.shorten
    });
    engine = 'local';
  }

  text = String(text || '').trim().replace(/^["“]|["”]$/g, '');
  if (!text) throw new Error('Nothing was written. Please try again.');

  const done = await Sessions.update(key, x => {
    x.versions.push({
      id: Date.now().toString(36),
      text, format: f.id,
      purpose, tone: options.tone || 'Neutral',
      mode: useDeep ? 'deep' : 'quick',
      hooks: hooks.map(h => h.text),
      commonGround: options.commonGround || [],
      revised: !!options.revise,
      engine, cost,
      createdAt: Date.now()
    });
    if (x.versions.length > 12) x.versions.shift();
    x.active = x.versions.length - 1;
    x.stage = 'done';
    x.steps.write = 'done';
    const secs = Math.max(1, Math.round((Date.now() - (x.startedAt || Date.now())) / 1000));
    const researchCost = options.researchCost || 0; // set when research ran in this same job
    x.notice = engine === 'local'
      ? 'Written on your device · free mode'
      : `Written in ${secs}s · ${Claude.MODELS[engine] || engine} · ${Claude.formatCost(cost + researchCost)}`;
    return x;
  });

  const p = Sessions.effectiveProfile(done) || {};
  await ContactStore.upsert({
    profileUrl: done.profileUrl || p.profileUrl || '',
    name:       p.name || 'Unknown',
    headline:   p.headline || '',
    company:    p.currentCompany || '',
    message:    text,
    format:     f.id,
    signals: {
      mode:   useDeep ? 'deep' : 'quick',
      format: f.id,
      tone:   options.tone || 'Neutral',
      purpose,
      recipient: recipient?.type || null,
      hooks:  hooks.length,
      common: (options.commonGround || []).length,
      engine
    }
  });
}

function retryNotice(key) {
  return (attempt, err) => Sessions.update(key, x => {
    x.notice = err.code === 'network' ? `Connection hiccup, retrying (${attempt})…`
      : err.code === 'rate_limit' ? `Rate limited by Anthropic, retrying (${attempt})…`
      : `Anthropic is busy, retrying (${attempt})…`;
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


// ─── Session patches from the panel (UI-owned fields only) ────────────────────
const PATCHABLE = ['edits', 'context', 'hooks', 'versions', 'active', 'commonPicks', 'checks'];

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

// ─── Your own profile (for common ground + fact-checking claims about you) ────
// linkedin.com/in/me/ redirects to the signed-in user's profile. Open it briefly
// in the foreground (lazy sections only render in a visible tab), read it, close it.
async function importMyProfile({ returnTabId, useTabId }) {
  let tabId = useTabId;
  let created = null;
  if (!tabId) {
    created = await chrome.tabs.create({ url: 'https://www.linkedin.com/in/me/', active: true });
    tabId = created.id;
  }
  try {
    const tab = await waitForTab(tabId, 25000);
    const key = Sessions.keyFromUrl(tab.url);
    if (!key || key === 'me') throw new Error('Couldn’t open your profile. Are you signed in to LinkedIn?');
    const profile = await scrapeTab(tabId, { full: true });
    const me = { ...profile, importedAt: Date.now() };
    const cur = await chrome.storage.local.get(['userName', 'userBio']);
    const save = { myProfile: me };
    if (!cur.userName && me.name) save.userName = me.name;
    if (!cur.userBio) save.userBio = bioFrom(me);
    await chrome.storage.local.set(save);
    return { profile: me, filledName: !!save.userName, filledBio: !!save.userBio };
  } finally {
    if (created) chrome.tabs.remove(created.id).catch(() => {});
    if (returnTabId) chrome.tabs.update(returnTabId, { active: true }).catch(() => {});
  }
}

async function waitForTab(tabId, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error('The LinkedIn tab was closed.');
    if (/\/(login|authwall|checkpoint|uas\/login)/.test(t.url || '')) throw new Error('Sign in to LinkedIn first, then try again.');
    const key = Sessions.keyFromUrl(t.url);
    if (t.status === 'complete' && key && key !== 'me') return t;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('LinkedIn took too long to load your profile.');
}

function bioFrom(p) {
  const parts = [];
  if (p.headline) parts.push(p.headline.replace(/\s*\|\s*/g, ', '));
  const firstSentences = (p.about || '').split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  if (firstSentences) parts.push(firstSentences);
  return parts.join('. ').replace(/\.\./g, '.').slice(0, 400);
}

// ─── The user's own Anthropic API key (optional) ──────────────────────────────
async function testKey(rawKey) {
  const key = (rawKey || '').trim();
  if (!key) throw new Error('Paste your Anthropic API key first.');
  let status;
  try {
    const data = await Claude.create(key, {
      model: 'claude-haiku-5-5', max_tokens: 1024, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }]
    }, { timeoutMs: 20000, retries: 1 });
    Claude.textOf(data);
    status = { status: 'valid' };
  } catch (err) {
    status = { status: ['auth', 'permission', 'billing'].includes(err.code) ? 'invalid' : 'unknown', reason: err.message, code: err.code };
  }
  status = { ...status, fingerprint: fingerprint(key), checkedAt: Date.now() };
  const save = { keyStatus: status };
  if (status.status !== 'invalid') save.userApiKey = key;
  await chrome.storage.local.set(save);
  return { keyStatus: status };
}

// Lets the panel know which key a status belongs to without storing the key twice.
function fingerprint(key) {
  return key ? `${key.slice(0, 7)}…${key.slice(-4)}` : '';
}

async function setKeyStatus(fields) {
  const { keyStatus = {}, userApiKey } = await chrome.storage.local.get(['keyStatus', 'userApiKey']);
  await chrome.storage.local.set({ keyStatus: { ...keyStatus, fingerprint: fingerprint(userApiKey), checkedAt: Date.now(), ...fields } });
}

async function getSettings() {
  return chrome.storage.local.get(SETTINGS_KEYS);
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
      message: `You messaged ${Names.first(c.name)} ${days} day${days === 1 ? '' : 's'} ago and haven't marked a reply.`,
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
