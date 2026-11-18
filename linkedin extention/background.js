'use strict';

// background.js — Extension backend (calls YOUR server, not OpenAI/Anthropic directly)
// All AI happens server-side. Extension only sends data + serial key.

const SERVER_URL = 'https://linkedin-extention-production.up.railway.app'; // ← UPDATE THIS after deploying

// ─── Router ───────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.action === 'scrapeProfile') {
    handleScrapeProfile(sendResponse);
    return true;
  }

  if (message.action === 'generateMessage') {
    handleQuickGenerate(message.data, sendResponse);
    return true;
  }

  if (message.type === 'VALIDATE_KEY') {
    handleValidateKey(message.payload, sendResponse);
    return true;
  }

  if (message.type === 'RUN_ENRICH') {
    handleEnrich(message.payload, sendResponse);
    return true;
  }

  if (message.type === 'RUN_GENERATE') {
    handleDeepGenerate(message.payload, sendResponse);
    return true;
  }

  if (message.type === 'SAVE_RECENT') {
    chrome.storage.local.get(['recentContacts'], (result) => {
      const recent  = result.recentContacts || [];
      const updated = [message.payload, ...recent.filter(c => c.profileUrl !== message.payload.profileUrl)].slice(0, 5);
      chrome.storage.local.set({ recentContacts: updated });
      sendResponse({ status: 'saved' });
    });
    return true;
  }

  if (message.type === 'GET_RECENT') {
    chrome.storage.local.get(['recentContacts'], (result) => {
      sendResponse({ contacts: result.recentContacts || [] });
    });
    return true;
  }
});

// ─── Scrape profile from active tab ───────────────────────────────────────────
async function handleScrapeProfile(sendResponse) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab  = tabs[0];
    if (!tab) throw new Error('No active tab found.');
    if (!tab.url || !tab.url.includes('linkedin.com')) {
      throw new Error('Please navigate to a LinkedIn profile page first.');
    }

    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
    } catch (_) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
      await delay(400);
      result = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
    }

    if (!result?.success) throw new Error(result?.error || 'Scrape failed.');
    sendResponse({ success: true, data: result.data });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Validate serial key ───────────────────────────────────────────────────────
async function handleValidateKey({ key }, sendResponse) {
  try {
    const res  = await fetch(`${SERVER_URL}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();
    sendResponse(data);
  } catch (err) {
    sendResponse({ valid: false, reason: 'Could not reach server. Check your connection.' });
  }
}

// ─── Quick Mode generate ───────────────────────────────────────────────────────
async function handleQuickGenerate(data, sendResponse) {
  try {
    const { profileData, settings, messageType, tone } = data;
    const key = await getStoredKey();
    if (!key) throw new Error('No license key found. Add it in Settings.');

    const res = await fetch(`${SERVER_URL}/api/generate/quick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        profileData,
        messageType,
        tone,
        userName:     settings.userName,
        userBio:      settings.userBio,
        resumeBase64: settings.resumeBase64 || null
      })
    });

    const result = await res.json();
    if (!res.ok || !result.success) throw new Error(result.error || 'Generation failed.');
    sendResponse({ success: true, generatedMessage: result.message });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Deep Mode enrich (L1 + L2) ───────────────────────────────────────────────
async function handleEnrich({ rawProfileData }, sendResponse) {
  try {
    const key = await getStoredKey();
    if (!key) throw new Error('No license key found. Add it in Settings.');

    const res = await fetch(`${SERVER_URL}/api/generate/enrich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, rawProfileData })
    });

    const result = await res.json();
    if (!res.ok || !result.success) throw new Error(result.error || 'Enrichment failed.');
    sendResponse({ status: 'enrich_complete', profileJSON: result.profileJSON, enrichmentJSON: result.enrichmentJSON });
  } catch (err) {
    sendResponse({ status: 'error', error: err.message });
  }
}

// ─── Deep Mode generate (L3) ──────────────────────────────────────────────────
async function handleDeepGenerate({ profileJSON, enrichmentJSON, messageType, tone }, sendResponse) {
  try {
    const key = await getStoredKey();
    const settings = await new Promise(resolve => chrome.storage.local.get(['resumeBase64'], resolve));
    if (!key) throw new Error('No license key found. Add it in Settings.');

    const res = await fetch(`${SERVER_URL}/api/generate/deep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, profileJSON, enrichmentJSON, messageType, tone, resumeBase64: settings.resumeBase64 || null })
    });

    const result = await res.json();
    if (!res.ok || !result.success) throw new Error(result.error || 'Generation failed.');
    sendResponse({ status: 'generate_complete', generatedMessage: result.message, remaining: result.remaining });
  } catch (err) {
    sendResponse({ status: 'error', error: err.message });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getStoredKey() {
  return new Promise(resolve => {
    chrome.storage.local.get(['licenseKey'], result => resolve(result.licenseKey || ''));
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
