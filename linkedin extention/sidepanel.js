'use strict';

// sidepanel.js — the UI. A view over two stores:
//   chrome.storage.session  "sess:<slug>"  per-profile work (owned by background.js)
//   chrome.storage.local    settings, license, contacts
// The panel never runs jobs itself. It sends intents to the background and
// re-renders when storage changes, so it can close and reopen at any moment.

const $  = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const SETTINGS_KEYS = ['licenseKey', 'userName', 'userBio', 'resumeFileName', 'license', 'prefs',
  'noteLimit', 'followUpDays', 'theme', 'showFab', 'onboarded'];
const DEFAULT_PREFS = { purpose: 'Networking', tone: 'Neutral', format: 'note', mode: 'quick' };

const state = {
  tab: null,
  key: null,
  session: null,
  settings: {},
  contacts: [],
  filter: 'all',
  query: '',
  expanded: new Set(),
  renderedVersionId: null,
  pinnedTabId: Number(new URLSearchParams(location.search).get('tabId')) || null
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  applyTheme();
  buildFormatControl();
  wireTabs();
  wireCompose();
  wireTracker();
  wireSettings();
  wireOnboarding();
  wireShortcuts();

  renderSettingsForm();
  renderOptions();
  renderQuota();
  renderTracker();
  await refreshTab();
  maybeOnboard();
  maybeRevalidate();

  chrome.storage.onChanged.addListener(onStorageChanged);
  if (!state.pinnedTabId) {
    chrome.tabs.onActivated.addListener(() => refreshTab());
    chrome.windows.onFocusChanged.addListener(() => refreshTab());
  }
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (!state.tab || tabId !== state.tab.id) return;
    if (info.url) refreshTab({ navigated: true });
    else if (info.status === 'complete' && state.key && !state.session?.profile) refreshTab();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
});

async function loadSettings() {
  state.settings = await chrome.storage.local.get(SETTINGS_KEYS);
  state.contacts = await ContactStore.list();
}

function prefs() { return { ...DEFAULT_PREFS, ...(state.settings.prefs || {}) }; }
function noteLimit() { return Number(state.settings.noteLimit) || 300; }

function send(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r || { ok: false, error: 'No response from the extension.' });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function onStorageChanged(changes, area) {
  if (area === 'session' && state.key && changes[Sessions.PREFIX + state.key]) {
    state.session = changes[Sessions.PREFIX + state.key].newValue || null;
    renderCompose();
    return;
  }
  if (area !== 'local') return;
  let touched = false;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (k === ContactStore.KEY) { state.contacts = newValue || []; renderTracker(); continue; }
    if (SETTINGS_KEYS.includes(k)) { state.settings[k] = newValue; touched = true; }
  }
  if (touched) {
    if (changes.theme) applyTheme();
    if (changes.license || changes.licenseKey) { renderQuota(); renderKeyStatus(); }
    if (changes.licenseKey) revalidateSoon();
    renderCompose();
  }
}

// ─── Tab tracking ─────────────────────────────────────────────────────────────
async function resolveTab() {
  if (state.pinnedTabId) return chrome.tabs.get(state.pinnedTabId).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

let refreshSeq = 0;
async function refreshTab({ navigated = false } = {}) {
  const seq = ++refreshSeq;
  const tab = await resolveTab();
  if (seq !== refreshSeq) return;
  state.tab = tab;
  const key = tab ? Sessions.keyFromUrl(tab.url) : null;
  if (key !== state.key) state.renderedVersionId = null;
  state.key = key;
  state.session = key ? await Sessions.get(key) : null;
  if (seq !== refreshSeq) return;
  renderCompose();

  if (key && tab.status !== 'loading' && !state.session?.profile && !state.session?.loadingProfile) {
    send({ type: 'SCRAPE', tabId: tab.id, key, light: true, delayMs: navigated ? 900 : 0 });
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function wireTabs() {
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.goto)));
  $('quota-chip').addEventListener('click', () => switchTab('settings'));
}

function switchTab(name) {
  $$('.tab-btn').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'tracker') renderTracker();
  if (name === 'settings') renderKeyStatus();
}

// ─── Compose: wiring ──────────────────────────────────────────────────────────
function buildFormatControl() {
  const wrap = $('opt-format');
  wrap.innerHTML = '';
  for (const f of Formats.list()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = f.id;
    b.textContent = f.label;
    wrap.appendChild(b);
  }
}

function wireSegmented(id, onPick) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (b) onPick(b.dataset.value);
  });
}

function setSegmented(id, value) {
  $$(`#${id} button`).forEach(b => {
    const on = b.dataset.value === String(value);
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

async function savePrefs(patch) {
  const next = { ...prefs(), ...patch };
  state.settings.prefs = next;
  renderOptions();
  renderCompose();
  await chrome.storage.local.set({ prefs: next });
}

function wireCompose() {
  $('opt-purpose').addEventListener('change', e => savePrefs({ purpose: e.target.value }));
  wireSegmented('opt-tone',   v => savePrefs({ tone: v }));
  wireSegmented('opt-format', v => savePrefs({ format: v }));
  wireSegmented('opt-mode',   v => savePrefs({ mode: v }));

  $('opt-context').addEventListener('input', debounce(e => patchSession({ context: e.target.value }), 350));

  $$('[data-edit]').forEach(el => el.addEventListener('input', debounce(() => {
    const edits = { ...(state.session?.edits || {}) };
    const sep = el.dataset.list;
    edits[el.dataset.edit] = sep
      ? el.value.split(sep === '1' ? /\n+/ : /\s*,\s*/).map(s => s.trim()).filter(Boolean)
      : el.value;
    patchSession({ edits });
  }, 350)));

  $('refresh-profile').addEventListener('click', async () => {
    if (!state.tab || !state.key) return;
    const r = await send({ type: 'SCRAPE', tabId: state.tab.id, key: state.key, light: false, force: true });
    if (r.ok && r.profile) toast('Profile re-read.');
    else if (!r.ok) toast(r.error, { type: 'error' });
  });

  $('primary-btn').addEventListener('click', () => onPrimary());
  $('regen-btn').addEventListener('click', () => onPrimary({ another: true }));
  $('shorten-btn').addEventListener('click', () => onPrimary({ another: true, shorten: true }));
  $('error-action').addEventListener('click', onErrorAction);

  $('fit-btn').addEventListener('click', () => {
    const v = activeVersion();
    if (!v) return;
    const text = Formats.fit($('message').value, v.format, { noteLimit: noteLimit() });
    pushLocalVersion({ ...v, text, id: Date.now().toString(36), createdAt: Date.now(), trimmed: true });
    toast('Trimmed to fit at a sentence boundary.');
  });

  $('message').addEventListener('input', () => {
    renderMeter();
    saveMessageEdit();
  });

  $('v-prev').addEventListener('click', () => stepVersion(-1));
  $('v-next').addEventListener('click', () => stepVersion(1));
  $('copy-btn').addEventListener('click', copyMessage);
  $('insert-btn').addEventListener('click', insertMessage);
  $('mark-sent-btn').addEventListener('click', () => toggleSent());
}

function currentOptions(extra = {}) {
  const p = prefs();
  return { purpose: p.purpose, tone: p.tone, format: p.format, mode: p.mode, ...extra };
}

async function onPrimary({ another = false, shorten = false } = {}) {
  if (!state.key || !state.tab) return;
  if (!state.settings.licenseKey) {
    toast('Add your license key first.', { type: 'error' });
    switchTab('settings');
    $('license-key').focus();
    return;
  }
  const s = state.session;
  if (Sessions.isBusy(s)) return;

  const p = prefs();
  const options = currentOptions({ shorten });
  // Deep mode with research already done → just (re)write with the chosen hooks.
  // Quick mode with a full profile → just write; no need to re-scrape.
  const canWriteOnly = (p.mode === 'deep' && s?.research) || (p.mode === 'quick' && s?.profile?.full && (another || s.versions?.length));
  const r = canWriteOnly
    ? await send({ type: 'WRITE', key: state.key, tabId: state.tab.id, options })
    : await send({ type: 'GENERATE', key: state.key, tabId: state.tab.id, mode: p.mode, options });
  if (!r.ok) toast(r.error, { type: 'error' });
}

function onErrorAction() {
  const code = state.session?.errorCode;
  if (code === 'auth' || code === 'no_key') { switchTab('settings'); $('license-key').focus(); return; }
  onPrimary();
}

function patchSession(patch) {
  if (!state.key) return;
  if (state.session) Object.assign(state.session, patch); // optimistic
  send({ type: 'PATCH_SESSION', key: state.key, patch });
}

// ─── Compose: rendering ───────────────────────────────────────────────────────
function renderOptions() {
  const p = prefs();
  $('opt-purpose').value = p.purpose;
  setSegmented('opt-tone', p.tone);
  setSegmented('opt-format', p.format);
  setSegmented('opt-mode', p.mode);
  const f = Formats.get(p.format, { noteLimit: noteLimit() });
  $('format-hint').textContent = f.desc;
}

function renderCompose() {
  const hasKey = !!state.settings.licenseKey;
  $('no-key-banner').classList.toggle('hidden', hasKey || !state.settings.onboarded);
  const onProfile = !!state.key;
  $('no-profile').classList.toggle('hidden', onProfile);
  $('compose').classList.toggle('hidden', !onProfile);
  if (!onProfile) return;

  const s = state.session || Sessions.blank(state.key);
  renderProfile(s);
  renderSteps(s);
  renderHooks(s);
  renderError(s);
  renderPrimary(s);
  renderResult(s);
}

function renderProfile(s) {
  const p = Sessions.effectiveProfile(s);
  const card = $('profile-card');
  card.classList.toggle('skeleton', !p && (s.loadingProfile || !s.profileError));

  if (!p) {
    $('p-avatar').textContent = '';
    $('p-name').textContent = s.profileError ? 'Couldn’t read this profile' : 'Reading profile…';
    $('p-headline').textContent = s.profileError || '';
    $('p-meta').textContent = '';
    $('review').classList.add('hidden');
    return;
  }

  $('p-avatar').textContent = initials(p.name);
  $('p-avatar').style.background = avatarColor(p.name);
  $('p-name').textContent = p.name || 'Unknown';
  $('p-headline').textContent = p.headline || '';
  $('p-meta').textContent = [p.currentCompany, p.location].filter(Boolean).join(' · ');
  $('refresh-profile').classList.toggle('spinning', !!s.loadingProfile);

  // What we know about them, so the user can judge how personal the message can be.
  const found = [
    p.currentTitle && 'role',
    p.about && 'about',
    p.experienceEntries?.length && `${p.experienceEntries.length} roles`,
    p.recentPosts?.length && `${p.recentPosts.length} post${p.recentPosts.length > 1 ? 's' : ''}`,
    p.skills?.length && `${p.skills.length} skills`
  ].filter(Boolean);
  const q = $('p-quality');
  q.className = 'quality ' + (found.length >= 4 ? 'good' : found.length >= 2 ? 'ok' : 'low');
  q.textContent = !s.profile.full && found.length < 3
    ? 'Top of profile read · full read happens when you generate'
    : found.length ? `Found: ${found.join(' · ')}` : 'Very little found. Add details below';
  $('review').classList.remove('hidden');

  for (const el of $$('[data-edit]')) {
    if (document.activeElement === el) continue;
    const v = p[el.dataset.edit];
    el.value = Array.isArray(v) ? v.join(el.dataset.list === '1' ? '\n' : ', ') : (v || '');
  }

  const ctx = $('opt-context');
  if (document.activeElement !== ctx) ctx.value = s.context || '';
  $('context-dot').classList.toggle('hidden', !(s.context || '').trim());
}

function renderSteps(s) {
  const show = s.stage !== 'idle' || s.versions.length;
  $('stepper').classList.toggle('hidden', !show);
  for (const li of $$('#stepper .step')) {
    const st = s.steps?.[li.dataset.step] || 'idle';
    li.dataset.state = st;
    li.classList.toggle('hidden', st === 'skip');
  }
  const note = $('step-note');
  note.textContent = s.notice || '';
  note.classList.toggle('hidden', !s.notice);
}

function renderHooks(s) {
  const box = $('hooks');
  const hooks = s.hooks || [];
  box.classList.toggle('hidden', !hooks.length || prefs().mode !== 'deep');
  const list = $('hooks-list');
  list.innerHTML = '';
  hooks.forEach((h, i) => {
    const label = document.createElement('label');
    label.className = 'hook';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!h.selected;
    cb.disabled = Sessions.isBusy(s);
    cb.addEventListener('change', () => {
      const next = hooks.map((x, j) => (j === i ? { ...x, selected: cb.checked } : x));
      patchSession({ hooks: next });
      renderPrimary(state.session);
    });
    const span = document.createElement('span');
    span.textContent = h.text;
    label.append(cb, span);
    list.appendChild(label);
  });
}

function renderError(s) {
  const show = s.stage === 'error' && s.error;
  $('error-banner').classList.toggle('hidden', !show);
  if (!show) return;
  $('error-text').textContent = s.error;
  $('error-action').textContent = (s.errorCode === 'auth' || s.errorCode === 'no_key') ? 'Open Settings' : 'Try again';
}

function renderPrimary(s) {
  const busy = Sessions.isBusy(s);
  const p = prefs();
  const nHooks = (s.hooks || []).filter(h => h.selected).length;
  const lastVersion = s.versions[s.versions.length - 1];
  let label;
  if (busy) {
    label = { reading: 'Reading profile…', researching: 'Researching…', writing: 'Writing…' }[s.stage];
  } else if (p.mode === 'deep' && s.research) {
    const changed = !lastVersion || lastVersion.mode !== 'deep' ||
      JSON.stringify(lastVersion.hooks || []) !== JSON.stringify((s.hooks || []).filter(h => h.selected).map(h => h.text));
    label = changed
      ? `Write with ${nHooks || 'no'} hook${nHooks === 1 ? '' : 's'}`
      : 'Write another version';
  } else if (p.mode === 'deep') {
    label = 'Research & write';
  } else {
    label = s.versions.length ? 'Write another version' : 'Generate message';
  }
  $('primary-label').textContent = label;
  $('primary-spinner').classList.toggle('hidden', !busy);
  $('primary-btn').disabled = busy;
  $('primary-btn').classList.toggle('btn-secondary', !busy && s.versions.length > 0);
  $('primary-btn').classList.toggle('btn-primary', busy || !s.versions.length);
  $('regen-btn').disabled = busy;
  $('shorten-btn').disabled = busy;
}

function activeVersion() {
  const s = state.session;
  return s && s.active >= 0 ? s.versions[s.active] : null;
}

function renderResult(s) {
  const v = activeVersion();
  if (!v) state.scrollToResult = true;
  $('result').classList.toggle('hidden', !v);
  $('result').classList.toggle('busy', Sessions.isBusy(s));
  if (!v) return;

  const ta = $('message');
  const isNew = state.renderedVersionId && state.renderedVersionId !== v.id && s.active === s.versions.length - 1;
  if (state.renderedVersionId !== v.id || document.activeElement !== ta) {
    if (ta.value !== v.text) ta.value = v.text;
    state.renderedVersionId = v.id;
  }
  if (isNew || state.scrollToResult) {
    state.scrollToResult = false;
    requestAnimationFrame(() => $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }
  const f = Formats.get(v.format, { noteLimit: noteLimit() });
  $('result-title').textContent = f.name.replace(/^LinkedIn /, '').replace(/^./, c => c.toUpperCase());
  $('versions').classList.toggle('hidden', s.versions.length < 2);
  $('v-label').textContent = `${s.active + 1} / ${s.versions.length}`;
  $('v-prev').disabled = s.active <= 0;
  $('v-next').disabled = s.active >= s.versions.length - 1;
  renderMeter();
  renderSentRow();
}

function renderMeter() {
  const v = activeVersion();
  if (!v) return;
  const m = Formats.measure($('message').value, v.format, { noteLimit: noteLimit() });
  $('meter').dataset.level = m.level;
  $('meter-fill').style.width = `${Math.round(m.pct * 100)}%`;
  $('meter-text').textContent = m.limit && m.format.id !== 'dm'
    ? `${m.n} / ${m.limit}`
    : `${m.n} chars · aim ≤ ${m.target}`;

  const fix = $('fix-row');
  if (m.level === 'over') {
    fix.classList.remove('hidden');
    $('fix-text').textContent = `${m.n - m.limit} over LinkedIn’s ${m.limit}-character limit.`;
    $('fit-btn').classList.remove('hidden');
  } else if (m.level === 'warn') {
    fix.classList.remove('hidden');
    $('fix-text').textContent = 'Longer than ideal. Short messages get more replies.';
    $('fit-btn').classList.add('hidden');
  } else {
    fix.classList.add('hidden');
  }
}

function contactForCurrent() {
  return state.contacts.find(c => c.id === state.key) || null;
}

function renderSentRow() {
  const c = contactForCurrent();
  const sent = c && (c.status === 'sent' || c.status === 'replied');
  $('sent-text').textContent = !c ? '' : c.status === 'replied' ? 'Marked as replied ✓' : sent ? `Marked as sent ${relTime(c.sentAt)}` : 'Saved to Tracker as a draft';
  $('mark-sent-btn').textContent = sent ? 'Undo' : 'Mark as sent';
  $('mark-sent-btn').classList.toggle('hidden', !c || c.status === 'replied');
}

// ─── Compose: actions ─────────────────────────────────────────────────────────
function stepVersion(delta) {
  const s = state.session;
  if (!s || !s.versions.length) return;
  const next = Math.min(s.versions.length - 1, Math.max(0, s.active + delta));
  if (next === s.active) return;
  patchSession({ active: next });
  renderResult(s);
}

const saveMessageEdit = debounce(() => {
  const s = state.session;
  const v = activeVersion();
  if (!s || !v) return;
  const versions = s.versions.map((x, i) => (i === s.active ? { ...x, text: $('message').value, edited: true } : x));
  patchSession({ versions });
}, 400);

function pushLocalVersion(v) {
  const s = state.session;
  const versions = [...s.versions, v].slice(-12);
  patchSession({ versions, active: versions.length - 1 });
  state.renderedVersionId = null;
  renderResult(state.session);
}

async function copyMessage() {
  const text = $('message').value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    $('message').select();
    document.execCommand('copy');
  }
  $('copy-label').textContent = 'Copied';
  setTimeout(() => { $('copy-label').textContent = 'Copy'; }, 1600);
}

async function insertMessage() {
  const text = $('message').value;
  if (!text || !state.tab) return;
  const r = await send({ type: 'INSERT', tabId: state.tab.id, text });
  const res = r.result || {};
  if (r.ok && res.success) {
    const where = res.target === 'note' ? 'your invite note' : 'the message box';
    if (res.over) {
      toast(`Inserted into ${where}, but it's over LinkedIn's ${res.maxLength}-char limit. Trim it first.`, { type: 'error', ms: 5000 });
    } else {
      toast(`Inserted into ${where}. Review it, then press Send.`, {
        action: { label: 'Mark as sent', fn: () => toggleSent(true) }, ms: 6000
      });
    }
    return;
  }
  await copyMessage();
  const v = activeVersion();
  const how = v?.format === 'note'
    ? 'Click Connect → Add a note, then press Insert again (or paste).'
    : 'Open a message to them, then press Insert again (or paste).';
  toast(`No LinkedIn box open, so I copied it instead. ${how}`, { ms: 6500 });
}

async function toggleSent(force) {
  const c = contactForCurrent();
  if (!c) return;
  const toSent = force === true || !(c.status === 'sent' || c.status === 'replied');
  const r = await send({ type: 'CONTACT_STATUS', id: c.id, status: toSent ? 'sent' : 'drafted' });
  if (r.ok && toSent) {
    const days = Number(state.settings.followUpDays ?? 5);
    toast(days ? `Marked as sent. I’ll remind you to follow up in ${days} days.` : 'Marked as sent.');
  }
}

// ─── Tracker ──────────────────────────────────────────────────────────────────
function wireTracker() {
  $('t-search').addEventListener('input', debounce(e => { state.query = e.target.value.trim().toLowerCase(); renderTracker(); }, 120));
  $('t-filters').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    $$('#t-filters .chip').forEach(c => c.classList.toggle('active', c === b));
    renderTracker();
  });
  $('t-export').addEventListener('click', exportCSV);
  $('t-clear').addEventListener('click', async () => {
    if (!confirm('Delete every contact from the tracker? This can’t be undone.')) return;
    await send({ type: 'CONTACTS_CLEAR' });
  });
}

function filteredContacts() {
  const now = Date.now();
  return state.contacts.filter(c => {
    if (state.filter === 'due' && !ContactStore.isDue(c, now)) return false;
    if (['drafted', 'sent', 'replied'].includes(state.filter) && c.status !== state.filter) return false;
    if (!state.query) return true;
    return [c.name, c.headline, c.company, c.message].join(' ').toLowerCase().includes(state.query);
  });
}

function renderTracker() {
  const due = state.contacts.filter(c => ContactStore.isDue(c)).length;
  $('due-badge').textContent = due;
  $('due-badge').classList.toggle('hidden', !due);
  const items = filteredContacts();
  const list = $('t-list');
  list.innerHTML = '';
  items.forEach(c => list.appendChild(contactCard(c)));

  const empty = !items.length;
  $('t-empty').classList.toggle('hidden', !empty);
  $('t-empty-text').textContent = state.contacts.length ? 'Nobody matches that filter.' : 'No one here yet.';
  $('t-foot').classList.toggle('hidden', !state.contacts.length);
  $('t-count').textContent = `${state.contacts.length} contact${state.contacts.length === 1 ? '' : 's'}`;
  if (state.key) renderSentRow();
}

function contactCard(c) {
  const card = document.createElement('article');
  card.className = 'contact';
  const due = ContactStore.isDue(c);
  const expanded = state.expanded.has(c.id);

  const head = el('div', 'contact-head');
  const av = el('div', 'avatar sm', initials(c.name));
  av.style.background = avatarColor(c.name);
  const info = el('div', 'contact-info');
  const nameEl = c.profileUrl ? el('a', 'contact-name', c.name || 'Unknown') : el('div', 'contact-name', c.name || 'Unknown');
  if (c.profileUrl) { nameEl.href = c.profileUrl; nameEl.target = '_blank'; nameEl.rel = 'noopener'; }
  info.append(nameEl, el('div', 'contact-meta', c.headline || c.company || ''));

  const status = document.createElement('select');
  status.className = `status-select status-${c.status}`;
  status.setAttribute('aria-label', `Status for ${c.name}`);
  for (const [v, l] of [['drafted', 'Drafted'], ['sent', 'Sent'], ['replied', 'Replied']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l; o.selected = c.status === v;
    status.appendChild(o);
  }
  status.addEventListener('change', () => send({ type: 'CONTACT_STATUS', id: c.id, status: status.value }));
  head.append(av, info, status);

  const sub = el('div', 'contact-sub');
  sub.textContent = `${Formats.get(c.format).label} · ${relTime(c.updatedAt || c.timestamp)}`;
  if (due) sub.appendChild(el('span', 'pill pill-warn', 'Follow up due'));
  else if (c.status === 'sent' && c.followUpAt) sub.appendChild(el('span', 'pill', `Follow up ${relTime(c.followUpAt)}`));

  const msg = el('div', 'contact-msg' + (expanded ? ' expanded' : ''), c.message || '');

  const actions = el('div', 'contact-actions');
  const more = el('button', 'link', expanded ? 'Show less' : 'Show more');
  more.type = 'button';
  more.addEventListener('click', () => {
    if (state.expanded.has(c.id)) state.expanded.delete(c.id); else state.expanded.add(c.id);
    renderTracker();
  });
  const copy = el('button', 'link', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(c.message || '').catch(() => {});
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
  });
  const del = el('button', 'link danger', 'Delete');
  del.type = 'button';
  del.addEventListener('click', () => send({ type: 'CONTACT_DELETE', id: c.id }));
  actions.append(more, copy, del);

  card.append(head, sub, msg, actions);
  return card;
}

function exportCSV() {
  const csv = ContactStore.toCSV(state.contacts);
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `outreach-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function wireSettings() {
  const flash = savedFlash();

  $('license-key').addEventListener('input', debounce(async (e) => {
    const licenseKey = e.target.value.trim().toUpperCase();
    await chrome.storage.local.set({ licenseKey });
    flash();
  }, 400));
  $('license-key').addEventListener('keydown', e => { if (e.key === 'Enter') verifyKey($('license-key'), $('validate-btn')); });
  $('validate-btn').addEventListener('click', () => verifyKey($('license-key'), $('validate-btn')));

  $('user-name').addEventListener('input', debounce(async e => { await chrome.storage.local.set({ userName: e.target.value.trim() }); flash(); }, 400));
  $('user-bio').addEventListener('input', e => { renderBioCount(); bioSave(e.target.value); });
  const bioSave = debounce(async (v) => { await chrome.storage.local.set({ userBio: v.trim() }); flash(); }, 400);

  const drop = $('file-drop');
  drop.addEventListener('click', () => $('resume-upload').click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('resume-upload').click(); } });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag-over'); if (e.dataTransfer.files[0]) saveResume(e.dataTransfer.files[0]); });
  $('resume-upload').addEventListener('change', e => { if (e.target.files[0]) saveResume(e.target.files[0]); e.target.value = ''; });
  $('resume-remove').addEventListener('click', async () => {
    await chrome.storage.local.remove(['resumeBase64', 'resumeFileName']);
    state.settings.resumeFileName = null;
    renderResume();
  });

  wireSegmented('set-note-limit', async v => { await chrome.storage.local.set({ noteLimit: Number(v) }); setSegmented('set-note-limit', v); renderOptions(); flash(); });
  wireSegmented('set-theme', async v => { await chrome.storage.local.set({ theme: v }); setSegmented('set-theme', v); flash(); });
  $('set-followup').addEventListener('change', async e => { await chrome.storage.local.set({ followUpDays: Number(e.target.value) }); flash(); });
  $('set-fab').addEventListener('change', async e => { await chrome.storage.local.set({ showFab: e.target.checked }); flash(); });
}

function renderSettingsForm() {
  const s = state.settings;
  $('license-key').value = s.licenseKey || '';
  $('user-name').value = s.userName || '';
  $('user-bio').value = s.userBio || '';
  renderBioCount();
  setSegmented('set-note-limit', noteLimit());
  setSegmented('set-theme', s.theme || 'system');
  $('set-followup').value = String(s.followUpDays ?? 5);
  $('set-fab').checked = s.showFab !== false;
  renderResume();
  renderKeyStatus();
}

function renderBioCount() {
  const n = $('user-bio').value.trim().length;
  $('bio-count').textContent = n ? `· ${n} chars` : '';
}

function renderResume() {
  const name = state.settings.resumeFileName;
  $('file-row').classList.toggle('hidden', !name);
  $('file-drop').classList.toggle('has-file', !!name);
  $('file-label').textContent = name ? 'Replace PDF' : 'Click or drop a PDF (max 4 MB)';
  $('file-status').textContent = name ? `✓ ${name}` : '';
}

function saveResume(file) {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return toast('Please choose a PDF file.', { type: 'error' });
  if (file.size > 4 * 1024 * 1024) return toast('That PDF is over 4 MB. Try a smaller export.', { type: 'error' });
  const reader = new FileReader();
  reader.onload = async (e) => {
    const resumeBase64 = String(e.target.result).split(',')[1];
    await chrome.storage.local.set({ resumeBase64, resumeFileName: file.name });
    state.settings.resumeFileName = file.name;
    renderResume();
    toast('Resume saved.');
  };
  reader.onerror = () => toast('Couldn’t read that file.', { type: 'error' });
  reader.readAsDataURL(file);
}

async function verifyKey(input, btn, statusEl = $('key-status')) {
  const key = input.value.trim().toUpperCase();
  if (!key) { input.focus(); return null; }
  input.value = key;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Checking…';
  const r = await send({ type: 'VALIDATE_KEY', key });
  btn.disabled = false;
  btn.textContent = prev;
  const lic = r.license || { status: 'unknown', reason: r.error };
  if (lic.status === 'unknown') await chrome.storage.local.set({ licenseKey: key }); // offline: keep it, verify later
  showKeyStatus(statusEl, lic);
  return lic;
}

function renderKeyStatus() {
  const s = state.settings;
  const lic = s.license;
  if (!s.licenseKey || !lic || lic.key !== s.licenseKey) { $('key-status').classList.add('hidden'); return; }
  showKeyStatus($('key-status'), lic);
}

function showKeyStatus(elm, lic) {
  elm.classList.remove('hidden');
  elm.dataset.status = lic.status;
  elm.textContent = lic.status === 'valid'
    ? `✓ Valid key${typeof lic.remaining === 'number' ? ` · ${lic.remaining} messages left today` : ''}`
    : lic.status === 'invalid' ? `✗ ${lic.reason || 'Invalid key'}` : `⚠ ${lic.reason || 'Couldn’t verify right now.'} Saved; we’ll retry.`;
}

function maybeRevalidate() {
  const { licenseKey, license } = state.settings;
  if (!licenseKey) return;
  const stale = !license || license.key !== licenseKey || Date.now() - (license.checkedAt || 0) > 6 * 3600e3;
  if (stale && license?.status !== 'invalid') send({ type: 'VALIDATE_KEY', key: licenseKey });
}

// A changed key gets checked once the user stops typing.
const revalidateSoon = debounce(() => {
  const { licenseKey, license } = state.settings;
  if (licenseKey && licenseKey.length >= 10 && license?.key !== licenseKey) send({ type: 'VALIDATE_KEY', key: licenseKey });
}, 1200);

function renderQuota() {
  const chip = $('quota-chip');
  const { licenseKey, license } = state.settings;
  let text, cls, title;
  if (!licenseKey) { text = 'No key'; cls = 'bad'; title = 'Add your license key in Settings'; }
  else if (!license || license.key !== licenseKey || license.status === 'unknown') { text = 'Key saved'; cls = 'neutral'; title = 'Not verified yet'; }
  else if (license.status === 'invalid') { text = 'Key invalid'; cls = 'bad'; title = license.reason || ''; }
  else if (typeof license.remaining === 'number') {
    text = license.remaining > 0 ? `${license.remaining} left today` : 'Limit reached';
    cls = license.remaining > 3 ? 'good' : license.remaining > 0 ? 'warn' : 'bad';
    title = 'Messages remaining today on your license';
  } else { text = 'Active'; cls = 'good'; title = 'License verified'; }
  chip.textContent = text;
  chip.className = `quota-chip ${cls}`;
  chip.title = title;
}

// ─── Onboarding ───────────────────────────────────────────────────────────────
function maybeOnboard() {
  if (state.settings.onboarded || state.settings.licenseKey) return;
  $('onboarding').classList.remove('hidden');
  setTimeout(() => $('ob-key').focus(), 50);
}

function obStep(n) {
  $$('.ob-step').forEach(s => s.classList.toggle('hidden', s.dataset.ob !== String(n)));
  $$('.ob-dots span').forEach((d, i) => d.classList.toggle('active', i < n));
  const focusable = { 1: 'ob-key', 2: 'ob-name', 3: 'ob-done' }[n];
  setTimeout(() => $(focusable)?.focus(), 30);
}

function wireOnboarding() {
  const verify = async () => {
    const lic = await verifyKey($('ob-key'), $('ob-verify'), $('ob-key-status'));
    if (lic && lic.status !== 'invalid') setTimeout(() => obStep(2), lic.status === 'valid' ? 700 : 1400);
  };
  $('ob-verify').addEventListener('click', verify);
  $('ob-key').addEventListener('keydown', e => { if (e.key === 'Enter') verify(); });
  $('ob-name').value = state.settings.userName || '';
  $('ob-bio').value = state.settings.userBio || '';
  $('ob-next').addEventListener('click', async () => {
    await chrome.storage.local.set({ userName: $('ob-name').value.trim(), userBio: $('ob-bio').value.trim() });
    obStep(3);
  });
  const finish = async () => {
    await chrome.storage.local.set({ onboarded: true });
    state.settings.onboarded = true;
    $('onboarding').classList.add('hidden');
    renderSettingsForm();
    renderCompose();
  };
  $('ob-done').addEventListener('click', finish);
  $('ob-skip').addEventListener('click', finish);
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────
function wireShortcuts() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const composeActive = $('view-compose').classList.contains('active');
    if (mod && e.key === 'Enter' && composeActive) { e.preventDefault(); onPrimary(); }
    else if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c') && composeActive && activeVersion()) { e.preventDefault(); copyMessage(); toast('Copied.'); }
    else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && composeActive) { e.preventDefault(); stepVersion(e.key === 'ArrowLeft' ? -1 : 1); }
    else if (e.key === 'Escape' && !$('onboarding').classList.contains('hidden')) { $('ob-skip').click(); }
  });
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme() {
  const t = state.settings.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(message, { type = '', action = null, ms = 3200 } = {}) {
  const t = $('toast');
  $('toast-text').textContent = message;
  const btn = $('toast-action');
  btn.classList.toggle('hidden', !action);
  btn.onclick = action ? () => { action.fn(); t.classList.remove('show'); } : null;
  if (action) btn.textContent = action.label;
  t.className = `toast show ${type ? 'toast-' + type : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function savedFlash() {
  let t;
  return () => {
    const elx = $('saved-indicator');
    elx.textContent = 'Saved ✓';
    elx.classList.add('show');
    clearTimeout(t);
    t = setTimeout(() => elx.classList.remove('show'), 1400);
  };
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function avatarColor(name) {
  const palette = ['#1A56DB', '#7C3AED', '#0E7490', '#047857', '#B45309', '#BE185D', '#4338CA'];
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function relTime(ts) {
  if (!ts) return '';
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60e3) return 'just now';
  if (abs < 3600e3) return rtf.format(Math.round(diff / 60e3), 'minute');
  if (abs < 86400e3) return rtf.format(Math.round(diff / 3600e3), 'hour');
  if (abs < 30 * 86400e3) return rtf.format(Math.round(diff / 86400e3), 'day');
  return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
