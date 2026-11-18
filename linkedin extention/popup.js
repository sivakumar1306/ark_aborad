'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let currentProfile     = null;
let isGenerating       = false;
let currentMode        = 'simple';
let deepProfileJSON    = null;
let deepEnrichmentJSON = null;
let isEnriching        = false;

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initModeToggle();
  wireSettingsEvents();
  wireCurrentEvents();
  wireRecentEvents();
  await checkCurrentPage();
  await loadSettings();
  await renderRecentContacts();
  await checkLicenseStatus();
});

// ─── License key status in header ────────────────────────────────────────────
async function checkLicenseStatus() {
  const s   = await loadStoredSettings();
  const key = (s.licenseKey || '').trim();
  const el  = document.getElementById('key-status');

  if (!key) {
    el.textContent = 'No Key';
    el.className   = 'key-status inactive';
    document.getElementById('no-key-warning').classList.remove('hidden');
    return;
  }

  el.textContent = '● Active';
  el.className   = 'key-status active';
  document.getElementById('no-key-warning').classList.add('hidden');
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${name}"]`).classList.add('active');
  document.getElementById(`tab-${name}`).classList.add('active');
  if (name === 'recent') renderRecentContacts();
}

// ─── Mode toggle ──────────────────────────────────────────────────────────────
function initModeToggle() {
  document.getElementById('mode-simple').addEventListener('click', () => setMode('simple'));
  document.getElementById('mode-deep').addEventListener('click', () => setMode('deep'));
}

function setMode(mode) {
  currentMode = mode;
  document.getElementById('mode-simple').classList.toggle('active', mode === 'simple');
  document.getElementById('mode-deep').classList.toggle('active', mode === 'deep');
  document.getElementById('simple-mode-ui').classList.toggle('hidden', mode === 'deep');
  document.getElementById('deep-mode-ui').classList.toggle('hidden', mode === 'simple');
  hideMessage();
  clearCurrentStatus();
}

// ─── Page check ───────────────────────────────────────────────────────────────
async function checkCurrentPage() {
  const tabs      = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab       = tabs[0];
  const onProfile = tab && tab.url && /linkedin\.com\/in\/[^/?#]+/.test(tab.url);
  document.getElementById('scrape-btn').disabled  = !onProfile;
  document.getElementById('enrich-btn').disabled  = !onProfile;
  if (!onProfile) {
    document.getElementById('page-warning').classList.remove('hidden');
  } else {
    document.getElementById('page-warning').classList.add('hidden');
  }
  return onProfile;
}

// ─── Wire events ──────────────────────────────────────────────────────────────
function wireCurrentEvents() {
  document.getElementById('scrape-btn').addEventListener('click', handleScrapeAndGenerate);
  document.getElementById('enrich-btn').addEventListener('click', handleEnrich);
  document.getElementById('deep-generate-btn').addEventListener('click', handleDeepGenerate);
  document.getElementById('regenerate-btn').addEventListener('click', handleRegenerate);
  document.getElementById('copy-btn').addEventListener('click', handleCopy);
  document.getElementById('generated-message').addEventListener('input', updateCharCount);
}

function wireSettingsEvents() {
  document.getElementById('save-settings-btn').addEventListener('click', handleSaveSettings);
  document.getElementById('validate-btn').addEventListener('click', handleValidateKey);
  document.getElementById('license-key').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleValidateKey();
  });

  // Resume upload
  const dropArea = document.getElementById('file-upload-area');
  dropArea.addEventListener('click', () => document.getElementById('resume-upload').click());
  dropArea.addEventListener('dragover', (e) => { e.preventDefault(); dropArea.classList.add('drag-over'); });
  dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
  dropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dropArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processResumeFile(file);
  });
  document.getElementById('resume-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) processResumeFile(file);
  });
}

function wireRecentEvents() {
  document.getElementById('clear-recent-btn').addEventListener('click', async () => {
    await Cache.clearContacts();
    renderRecentContacts();
  });
}

// ─── Simple Mode ──────────────────────────────────────────────────────────────
async function handleScrapeAndGenerate() {
  if (isGenerating) return;

  const s = await loadStoredSettings();
  if (!s.licenseKey) {
    showCurrentStatus('No license key. Add it in Settings.', 'error');
    switchTab('settings');
    return;
  }

  isGenerating = true;
  hideMessage();
  setButtonLoading('scrape-btn', 'btn-label', 'btn-spinner', true, 'Scraping profile…');
  clearCurrentStatus();

  try {
    const profile = await sendToBackground({ action: 'scrapeProfile' });
    currentProfile = profile;
    renderProfileCard(profile);
    setButtonLoading('scrape-btn', 'btn-label', 'btn-spinner', true, 'Generating message…');

    const message = await callQuickGenerate(profile);
    renderMessage(message);

    await Cache.addContact({
      profileUrl: profile.profileUrl || '',
      name:       profile.name       || 'Unknown',
      headline:   profile.headline   || '',
      company:    profile.currentCompany || '',
      message,
      timestamp:  Date.now()
    });

    showCurrentStatus('Message ready.', 'success');
  } catch (err) {
    showCurrentStatus(err.message, 'error');
  } finally {
    isGenerating = false;
    setButtonLoading('scrape-btn', 'btn-label', 'btn-spinner', false, 'Scrape &amp; Generate');
  }
}

async function callQuickGenerate(profile) {
  const settings    = await loadStoredSettings();
  const messageType = document.getElementById('message-type').value;
  const tone        = document.getElementById('tone').value;
  return sendToBackground({ action: 'generateMessage', data: { profileData: profile, settings, messageType, tone } });
}

async function handleRegenerate() {
  if (isGenerating) return;
  if (currentMode === 'deep') { handleDeepGenerate(); return; }
  if (!currentProfile) return;

  isGenerating = true;
  setButtonLoading('scrape-btn', 'btn-label', 'btn-spinner', true, 'Regenerating…');

  try {
    const message = await callQuickGenerate(currentProfile);
    renderMessage(message);
    showCurrentStatus('Regenerated!', 'success');
  } catch (err) {
    showCurrentStatus(err.message, 'error');
  } finally {
    isGenerating = false;
    setButtonLoading('scrape-btn', 'btn-label', 'btn-spinner', false, 'Scrape &amp; Generate');
  }
}

// ─── Deep Mode ────────────────────────────────────────────────────────────────
async function handleEnrich() {
  if (isEnriching) return;

  const s = await loadStoredSettings();
  if (!s.licenseKey) {
    showCurrentStatus('No license key. Add it in Settings.', 'error');
    switchTab('settings');
    return;
  }

  deepProfileJSON = null;
  deepEnrichmentJSON = null;
  resetLayerStatuses();
  document.getElementById('hooks-panel').classList.add('hidden');
  document.getElementById('deep-generate-btn').disabled = true;
  hideMessage();
  clearCurrentStatus();

  isEnriching = true;
  setButtonLoading('enrich-btn', 'enrich-label', 'enrich-spinner', true, 'Scraping profile…');
  setLayerStatus(1, 'running', 'Scraping…');

  let rawProfileData;
  try {
    rawProfileData = await sendToBackground({ action: 'scrapeProfile' });
  } catch (err) {
    setLayerStatus(1, 'error', 'Failed');
    showCurrentStatus('Could not scrape. Are you on a LinkedIn profile page?', 'error');
    isEnriching = false;
    setButtonLoading('enrich-btn', 'enrich-label', 'enrich-spinner', false, 'Scrape + Enrich (L1 + L2)');
    return;
  }

  currentProfile = rawProfileData;
  renderProfileCard(rawProfileData);
  setLayerStatus(1, 'running', 'Parsing…');
  setButtonLoading('enrich-btn', 'enrich-label', 'enrich-spinner', true, 'Running AI layers…');
  showCurrentStatus('Enriching — this takes ~20 seconds…');

  chrome.runtime.sendMessage({ type: 'RUN_ENRICH', payload: { rawProfileData } }, (response) => {
    isEnriching = false;
    setButtonLoading('enrich-btn', 'enrich-label', 'enrich-spinner', false, 'Scrape + Enrich (L1 + L2)');

    if (chrome.runtime.lastError || !response) {
      setLayerStatus(1, 'error', 'Error');
      setLayerStatus(2, 'error', 'Error');
      showCurrentStatus('Pipeline error. Check your connection.', 'error');
      return;
    }

    if (response.status === 'error') {
      setLayerStatus(1, 'error', 'Error');
      setLayerStatus(2, 'error', 'Error');
      showCurrentStatus(response.error, 'error');
      return;
    }

    setLayerStatus(1, 'done', 'Done');
    setLayerStatus(2, 'done', 'Done');
    deepProfileJSON    = response.profileJSON;
    deepEnrichmentJSON = response.enrichmentJSON;
    renderProfileCard({ name: deepProfileJSON.name, headline: deepProfileJSON.headline, currentCompany: deepProfileJSON.currentCompany });
    renderHooks(deepEnrichmentJSON);
    setLayerStatus(3, '', 'Ready');
    document.getElementById('deep-generate-btn').disabled = false;
    showCurrentStatus('Enrichment done. Hit Generate Message.', 'success');
  });
}

async function handleDeepGenerate() {
  if (isGenerating || !deepProfileJSON || !deepEnrichmentJSON) return;

  isGenerating = true;
  setButtonLoading('deep-generate-btn', 'deep-gen-label', 'deep-gen-spinner', true, 'Claude is writing…');
  setLayerStatus(3, 'running', 'Writing…');
  showCurrentStatus('Layer 3: Claude writing message…');
  hideMessage();

  const messageType = document.getElementById('message-type').value;
  const tone        = document.getElementById('tone').value;

  chrome.runtime.sendMessage(
    { type: 'RUN_GENERATE', payload: { profileJSON: deepProfileJSON, enrichmentJSON: deepEnrichmentJSON, messageType, tone } },
    async (response) => {
      isGenerating = false;
      setButtonLoading('deep-generate-btn', 'deep-gen-label', 'deep-gen-spinner', false, 'Generate Message (L3 — Claude)');

      if (chrome.runtime.lastError || !response) {
        setLayerStatus(3, 'error', 'Error');
        showCurrentStatus('Generation failed.', 'error');
        return;
      }

      if (response.status === 'error') {
        setLayerStatus(3, 'error', 'Error');
        showCurrentStatus(response.error, 'error');
        return;
      }

      setLayerStatus(3, 'done', 'Done');
      renderMessage(response.generatedMessage);
      const rem = response.remaining !== undefined ? ` (${response.remaining} messages left today)` : '';
      showCurrentStatus(`Message ready.${rem}`, 'success');

      await Cache.addContact({
        profileUrl: deepProfileJSON.profileUrl || '',
        name:       deepProfileJSON.name || 'Unknown',
        headline:   deepProfileJSON.headline || '',
        company:    deepProfileJSON.currentCompany || '',
        message:    response.generatedMessage,
        timestamp:  Date.now()
      });
    }
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  const s = await loadStoredSettings();
  if (s.licenseKey) document.getElementById('license-key').value = s.licenseKey;
  if (s.userName)   document.getElementById('user-name').value   = s.userName;
  if (s.userBio)    document.getElementById('user-bio').value    = s.userBio;
  if (s.resumeFileName) {
    document.getElementById('file-label').textContent = s.resumeFileName;
    document.getElementById('file-upload-area').classList.add('has-file');
    const statusEl = document.getElementById('resume-status');
    statusEl.textContent = `${s.resumeFileName} saved ✓`;
    statusEl.className   = 'resume-status success';
    statusEl.classList.remove('hidden');
  }
}

async function handleSaveSettings() {
  const licenseKey = document.getElementById('license-key').value.trim().toUpperCase();
  const userName   = document.getElementById('user-name').value.trim();
  const userBio    = document.getElementById('user-bio').value.trim();

  const savePayload = { licenseKey, userName, userBio };
  if (pendingResume) {
    savePayload.resumeBase64   = pendingResume.base64;
    savePayload.resumeFileName = pendingResume.fileName;
    pendingResume = null;
    const statusEl = document.getElementById('resume-status');
    statusEl.textContent = 'Resume saved ✓';
    statusEl.className   = 'resume-status success';
  }
  await new Promise(resolve => chrome.storage.local.set(savePayload, resolve));
  showSettingsStatus('Settings saved!', 'success');
  await checkLicenseStatus();
}

async function handleValidateKey() {
  const key = document.getElementById('license-key').value.trim().toUpperCase();
  if (!key) return;

  const btn = document.getElementById('validate-btn');
  btn.textContent = '…';
  btn.disabled = true;

  const result = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'VALIDATE_KEY', payload: { key } }, resolve);
  });

  btn.textContent = 'Verify';
  btn.disabled = false;

  const el = document.getElementById('key-validation-status');
  el.classList.remove('hidden');

  if (result && result.valid) {
    el.textContent = `✓ Valid key — ${result.remaining} messages remaining today`;
    el.className   = 'key-validation-status valid';
    // Auto-save the key
    const s = await loadStoredSettings();
    await new Promise(resolve => chrome.storage.local.set({ ...s, licenseKey: key }, resolve));
    await checkLicenseStatus();
  } else {
    el.textContent = `✗ ${result?.reason || 'Invalid key'}`;
    el.className   = 'key-validation-status invalid';
  }
}

// ─── Pipeline UI ──────────────────────────────────────────────────────────────
function setLayerStatus(layer, status, text) {
  document.getElementById(`l${layer}-dot`).className = `status-dot ${status}`;
  document.getElementById(`l${layer}-text`).textContent = text;
}

function resetLayerStatuses() {
  [1,2].forEach(n => setLayerStatus(n, '', 'Ready'));
  setLayerStatus(3, '', 'Waiting');
}

function renderHooks(enrichmentJSON) {
  const panel = document.getElementById('hooks-panel');
  const list  = document.getElementById('hooks-list');
  list.innerHTML = '';
  const hooks = enrichmentJSON.topHooks?.length
    ? enrichmentJSON.topHooks
    : (enrichmentJSON.companyNews || []).map(n => n.relevance || n.headline).filter(Boolean);
  if (!hooks.length) return;
  hooks.slice(0, 3).forEach(hook => {
    const d = document.createElement('div');
    d.className   = 'hook-item';
    d.textContent = hook;
    list.appendChild(d);
  });
  panel.classList.remove('hidden');
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function renderProfileCard(data) {
  const section = document.getElementById('profile-section');
  section.classList.remove('hidden');
  const name = data.name || 'Unknown';
  document.getElementById('profile-avatar').textContent  = name.charAt(0).toUpperCase();
  document.getElementById('profile-name').textContent    = name;
  document.getElementById('profile-headline').textContent = data.headline || '';
  document.getElementById('profile-company').textContent  = data.currentCompany || '';
}

function renderMessage(text) {
  document.getElementById('generated-message').value = text;
  document.getElementById('message-section').classList.remove('hidden');
  updateCharCount();
}

function hideMessage() { document.getElementById('message-section').classList.add('hidden'); }
function updateCharCount() {
  document.getElementById('char-count').textContent = `${document.getElementById('generated-message').value.length} chars`;
}

async function handleCopy() {
  const text = document.getElementById('generated-message').value;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch(_) {
    const ta = document.getElementById('generated-message');
    ta.select(); document.execCommand('copy');
  }
  const btn = document.getElementById('copy-btn');
  btn.textContent = '✓ Copied!';
  btn.classList.add('btn-secondary'); btn.classList.remove('btn-primary');
  setTimeout(() => {
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy`;
    btn.classList.remove('btn-secondary'); btn.classList.add('btn-primary');
  }, 2200);
}

function showCurrentStatus(msg, type = '') {
  const el = document.getElementById('status-message');
  el.textContent = msg;
  el.className = `status-bar${type ? ' status-' + type : ''}`;
  el.classList.remove('hidden');
}

function clearCurrentStatus() {
  const el = document.getElementById('status-message');
  el.classList.add('hidden');
  el.textContent = '';
}

function showSettingsStatus(msg, type = '') {
  const el = document.getElementById('settings-status');
  el.textContent = msg;
  el.className = `status-bar${type ? ' status-' + type : ''}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

function setButtonLoading(btnId, labelId, spinnerId, loading, labelText) {
  document.getElementById(btnId).disabled = loading;
  document.getElementById(labelId).innerHTML = labelText;
  document.getElementById(spinnerId).classList.toggle('hidden', !loading);
}

// ─── Recent contacts ──────────────────────────────────────────────────────────
async function renderRecentContacts() {
  const contacts  = await Cache.getContacts();
  const listEl    = document.getElementById('recent-list');
  const emptyEl   = document.getElementById('no-recent');
  const actionsEl = document.getElementById('recent-actions');
  listEl.innerHTML = '';
  if (contacts.length === 0) {
    emptyEl.classList.remove('hidden'); actionsEl.classList.add('hidden'); return;
  }
  emptyEl.classList.add('hidden'); actionsEl.classList.remove('hidden');
  contacts.forEach((c, i) => listEl.appendChild(buildContactCard(c, i)));
}

function buildContactCard(contact, idx) {
  const card = document.createElement('div');
  card.className = 'contact-card';
  const date    = new Date(contact.timestamp).toLocaleDateString('en-US', { month:'short', day:'numeric' });
  const preview = (contact.message || '').substring(0, 110) + ((contact.message || '').length > 110 ? '…' : '');
  card.innerHTML = `
    <div class="contact-header">
      <div class="contact-info">
        <div class="contact-name">${esc(contact.name||'Unknown')}</div>
        <div class="contact-meta">${esc(contact.headline||contact.company||'')}</div>
      </div>
      <div class="contact-date">${esc(date)}</div>
    </div>
    <div class="contact-message-preview" id="prev-${idx}">${esc(preview)}</div>
    <div class="contact-message-full hidden" id="full-${idx}">${esc(contact.message||'')}</div>
    <div class="contact-actions">
      <button class="btn-link" id="expand-${idx}">Show full message</button>
      <button class="btn btn-sm btn-primary" id="copy-c-${idx}">Copy</button>
    </div>`;

  card.querySelector(`#expand-${idx}`).addEventListener('click', () => {
    const isHidden = card.querySelector(`#full-${idx}`).classList.contains('hidden');
    card.querySelector(`#prev-${idx}`).classList.toggle('hidden', isHidden);
    card.querySelector(`#full-${idx}`).classList.toggle('hidden', !isHidden);
    card.querySelector(`#expand-${idx}`).textContent = isHidden ? 'Show less' : 'Show full message';
  });

  card.querySelector(`#copy-c-${idx}`).addEventListener('click', async () => {
    await navigator.clipboard.writeText(contact.message || '').catch(() => {});
    const btn = card.querySelector(`#copy-c-${idx}`);
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2200);
  });

  return card;
}

// ─── Chrome messaging ─────────────────────────────────────────────────────────
function sendToBackground(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!response) { reject(new Error('No response from background.')); return; }
      if (!response.success) { reject(new Error(response.error || 'Background returned an error.')); return; }
      if (response.data !== undefined) { resolve(response.data); return; }
      if (response.generatedMessage !== undefined) { resolve(response.generatedMessage); return; }
      reject(new Error('Unexpected response: ' + JSON.stringify(Object.keys(response))));
    });
  });
}

// ─── Resume upload ────────────────────────────────────────────────────────────
let pendingResume = null;

function processResumeFile(file) {
  const statusEl  = document.getElementById('resume-status');
  const dropArea  = document.getElementById('file-upload-area');
  const fileLabel = document.getElementById('file-label');

  if (file.type !== 'application/pdf') {
    statusEl.textContent = 'Please upload a PDF file.';
    statusEl.className   = 'resume-status error';
    statusEl.classList.remove('hidden');
    return;
  }

  if (file.size > 4 * 1024 * 1024) {
    statusEl.textContent = 'File too large — max 4MB.';
    statusEl.className   = 'resume-status error';
    statusEl.classList.remove('hidden');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const base64 = e.target.result.split(',')[1];
    pendingResume = { base64, fileName: file.name };
    fileLabel.textContent = file.name;
    dropArea.classList.add('has-file');
    statusEl.textContent  = `${file.name} ready — click Save Settings to confirm.`;
    statusEl.className    = 'resume-status pending';
    statusEl.classList.remove('hidden');
  };
  reader.onerror = () => {
    statusEl.textContent = 'Error reading file.';
    statusEl.className   = 'resume-status error';
    statusEl.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function loadStoredSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['licenseKey','userName','userBio','resumeBase64','resumeFileName'], resolve);
  });
}

function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
