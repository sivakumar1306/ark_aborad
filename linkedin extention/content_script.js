'use strict';

// content_script.js — runs on linkedin.com.
//  1. Reads the profile you're looking at (structure-first, text-heuristics as fallback).
//  2. Inserts a generated message into LinkedIn's invite-note / message box (never sends).
//  3. Shows a small "Write outreach" button on profile pages that opens the side panel.

(() => {
  if (window.__arkOutreachLoaded) return;
  window.__arkOutreachLoaded = true;

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const wait  = (ms) => new Promise(r => setTimeout(r, ms));
  const DATE_RE = /\b(19|20)\d{2}\b|\bpresent\b|\b\d+\s*(yrs?|mos?)\b/i;
  const JUNK_RE = /^(show all|see all|show more|see more|…more|endorse|follow|message|connect|more|activity)$|endorsement|followers?$|connections?$|^\d+ (comments?|reposts?|reactions?)$/i;

  // ─── Messages from the extension ────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'scrapeProfile') {
      scrape(msg).then(
        data => sendResponse({ success: true, data }),
        err  => sendResponse({ success: false, error: err.message })
      );
      return true;
    }
    if (msg.action === 'insertMessage') {
      sendResponse(insertMessage(msg.text || ''));
      return false;
    }
    if (msg.action === 'ping') { sendResponse({ ok: true }); return false; }
    return false;
  });

  // ─── Scraping ───────────────────────────────────────────────────────────────
  function currentSlug() {
    const m = /\/in\/([^/?#]+)/i.exec(location.pathname);
    if (!m) return null;
    try { return decodeURIComponent(m[1]).toLowerCase(); } catch (_) { return m[1].toLowerCase(); }
  }

  async function scrape({ full = true, expectKey } = {}) {
    if (!currentSlug()) throw new Error('This isn’t a LinkedIn profile page.');
    if (expectKey && currentSlug() !== expectKey) await wait(600); // SPA still swapping pages
    await waitFor(() => document.querySelector('main h1, h1'), 5000);
    if (full) await loadLazySections();
    const data = scrapeProfile();
    if (!data.name) throw new Error('Couldn’t find the profile on this page yet — wait for it to load, then try again.');
    return { ...data, full: !!full, scrapedAt: Date.now() };
  }

  async function waitFor(fn, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (fn()) return true;
      await wait(150);
    }
    return false;
  }

  // LinkedIn lazy-renders sections below the fold. Nudge them into existence,
  // then put the user back exactly where they were.
  async function loadLazySections() {
    const needed = ['experience', 'education', 'skills'];
    const hasAll = () => needed.every(n => getSection(n)?.querySelector('li, p'));
    if (hasAll()) return;
    const startY = window.scrollY;
    const maxY = Math.min(document.body.scrollHeight, 6000);
    for (let y = startY + 700; y < maxY; y += 700) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await wait(220);
      if (hasAll()) break;
    }
    window.scrollTo({ top: startY, behavior: 'instant' });
    await wait(80);
  }

  function getSection(name) {
    const anchor = document.getElementById(name);
    const bySec = anchor?.closest('section');
    if (bySec) return bySec;
    return Array.from(document.querySelectorAll('section')).find(s => {
      const h = s.querySelector('h2');
      return h && clean(h.innerText || h.textContent).toLowerCase().startsWith(name.toLowerCase());
    }) || null;
  }

  // Visible leaf text. LinkedIn duplicates every string in a visually-hidden span;
  // the aria-hidden="true" copy is the one users see, so prefer it when present.
  function leafTexts(root) {
    if (!root) return [];
    let els = Array.from(root.querySelectorAll('span[aria-hidden="true"]'));
    if (!els.length) {
      els = Array.from(root.querySelectorAll('p, span, a, div'))
        .filter(el => el.children.length === 0 && !el.closest('.visually-hidden, .sr-only'));
    }
    const out = [];
    for (const el of els) {
      const t = clean(el.innerText || el.textContent);
      if (t.length < 2 || /^[·•|\s]+$/.test(t) || JUNK_RE.test(t)) continue;
      if (out[out.length - 1] !== t) out.push(t);
    }
    return out;
  }

  // Top-level list items of a section (nested <li> are sub-roles, not entries).
  function topItems(section) {
    if (!section) return [];
    return Array.from(section.querySelectorAll('li')).filter(li => {
      const parentLi = li.parentElement?.closest('li');
      return !parentLi || !section.contains(parentLi);
    }).filter(li => leafTexts(li).length > 0);
  }

  function scrapeProfile() {
    const h1 = document.querySelector('main h1') || document.querySelector('h1');
    const name = clean(h1?.innerText || h1?.textContent) || clean(document.title.split('|')[0].replace(/^\(\d+\)\s*/, ''));
    const top = h1?.closest('section') || h1?.parentElement?.parentElement?.parentElement || document;

    // Headline & location — known selectors first, heuristics second.
    let headline = clean(top.querySelector('.text-body-medium')?.innerText);
    let loc = clean(top.querySelector('.text-body-small.inline, [data-test-location]')?.innerText);
    if (!headline || !loc) {
      const texts = Array.from(top.querySelectorAll('p, div, span'))
        .filter(el => el.children.length === 0)
        .map(el => clean(el.innerText || el.textContent))
        .filter(t => t.length > 3 && t !== name && !JUNK_RE.test(t) && !/contact info|mutual|^he\/him|^she\/her|^they\/them/i.test(t));
      if (!headline) {
        headline = texts.find(t => t.length > 12 && (/[|@·]/.test(t) || /\b(at|manager|engineer|analyst|developer|designer|founder|director|lead|head|specialist|consultant|intern|student|researcher|scientist|product|marketing|sales|recruiter|ceo|cto|vp)\b/i.test(t))) || texts[0] || '';
      }
      if (!loc) {
        loc = texts.find(t => t !== headline && /,/.test(t) && t.length < 70 && !/[|@]/.test(t) && !/\d{3,}/.test(t)) || '';
      }
    }

    // About
    const aboutTexts = leafTexts(getSection('about')).filter(t => !/^about$/i.test(t));
    const about = aboutTexts.sort((a, b) => b.length - a.length)[0] || '';

    // Experience
    const experienceEntries = parseExperience(getSection('experience'));
    const currentEntry   = experienceEntries[0] || null;
    const currentTitle   = currentEntry?.title   || fromHeadline(headline, 'title');
    const currentCompany = currentEntry?.company || fromHeadline(headline, 'company');
    const pastCompanies  = [...new Set(experienceEntries.slice(1).map(e => e.company).filter(c => c && c !== currentCompany))];

    // Education
    const eduSection = getSection('education');
    let educationEntries = topItems(eduSection).map(li => leafTexts(li).slice(0, 2).join(' — '));
    if (!educationEntries.length) {
      const t = leafTexts(eduSection).filter(x => !/^education$/i.test(x));
      for (let i = 0; i < t.length; i += 3) educationEntries.push([t[i], t[i + 1]].filter(Boolean).join(' — '));
    }

    // Skills
    const skillSection = getSection('skills');
    let skills = topItems(skillSection).map(li => leafTexts(li)[0]);
    if (!skills.length) skills = leafTexts(skillSection);
    skills = [...new Set(skills.filter(t => t && !/^skills$/i.test(t) && t.length < 60 && !DATE_RE.test(t) && !/passed|assessment|dialog|window|escape/i.test(t)))];

    // Recent posts
    const recentPosts = [];
    const act = getSection('activity');
    if (act) {
      const items = topItems(act);
      const sources = items.length ? items.map(li => leafTexts(li).sort((a, b) => b.length - a.length)[0]) : leafTexts(act);
      for (const t of sources) {
        if (t && t.length > 40 && t.length < 1200 && !/dialog|window|escape|notifications|premium|people you may|you might|followers/i.test(t) && !recentPosts.includes(t)) {
          recentPosts.push(t.slice(0, 500));
        }
      }
    }

    return {
      name,
      headline,
      currentTitle,
      currentCompany,
      location: loc,
      about: about.slice(0, 2600),
      recentPosts:       recentPosts.slice(0, 3),
      experienceEntries: experienceEntries.slice(0, 5),
      pastCompanies:     pastCompanies.slice(0, 4),
      educationEntries:  educationEntries.filter(Boolean).slice(0, 3),
      skills:            skills.slice(0, 12),
      profileUrl:        window.location.origin + window.location.pathname.replace(/\/+$/, '') + '/',
      rawTitle:          document.title
    };
  }

  function parseExperience(section) {
    if (!section) return [];
    const entries = [];
    const items = topItems(section);

    for (const li of items) {
      const texts = leafTexts(li).filter(t => !/^experience$/i.test(t));
      if (!texts.length) continue;

      // Grouped roles: "Company / Full-time · 3 yrs 2 mos" with nested <li> per role.
      const nested = Array.from(li.querySelectorAll('li')).filter(n => leafTexts(n).some(t => DATE_RE.test(t)));
      if (nested.length && texts[1] && DATE_RE.test(texts[1]) && !/\b(19|20)\d{2}\b/.test(texts[1])) {
        const company = texts[0];
        for (const n of nested) {
          const t = leafTexts(n);
          entries.push(entryFrom(t[0], company, t.find(x => DATE_RE.test(x))));
        }
        continue;
      }

      const title    = texts[0];
      const company  = texts[1] && !DATE_RE.test(texts[1]) ? texts[1].split('·')[0].trim() : null;
      const duration = texts.find(t => DATE_RE.test(t) && t.length < 80) || null;
      const description = texts.slice(2).filter(t => t.length > 60).sort((a, b) => b.length - a.length)[0];
      entries.push({ ...entryFrom(title, company, duration), ...(description ? { description: description.slice(0, 400) } : {}) });
    }

    if (entries.length) return markCurrent(entries);

    // Fallback for layouts without list items: each date line closes an entry.
    const texts = leafTexts(section).filter(t => !/^experience$/i.test(t));
    let buf = [];
    for (const t of texts) {
      if (DATE_RE.test(t) && t.length < 80) {
        // The two lines right before a date are title + company; anything earlier
        // (previous entry's location/description) is noise.
        const [title, company] = buf.length >= 2 ? buf.slice(-2) : [buf[0], null];
        if (title) entries.push(entryFrom(title, company ? company.split('·')[0].trim() : null, t));
        buf = [];
      } else {
        buf.push(t);
      }
    }
    return markCurrent(entries);
  }

  function entryFrom(title, company, duration) {
    return { title: title || null, company: company || null, duration: duration || null };
  }

  function markCurrent(entries) {
    return entries.map((e, i) => ({ ...e, isCurrent: i === 0 || /present/i.test(e.duration || '') }));
  }

  function fromHeadline(headline, field) {
    if (!headline) return null;
    const at = headline.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|·].*)?$/i);
    if (at) return field === 'title' ? at[1].trim() : at[2].trim();
    const pipe = headline.match(/^(.+?)\s*[|·]\s*(.+)$/);
    if (pipe) return field === 'title' ? pipe[1].trim() : pipe[2].split(/[|·]/)[0].trim();
    return field === 'title' ? headline : null;
  }

  // ─── Insert into LinkedIn ───────────────────────────────────────────────────
  // Fills the box; the user always presses Send themselves.
  function insertMessage(text) {
    const visible = (el) => el && el.offsetParent !== null && !el.disabled;

    // 1. "Add a note" textarea in the connection invite modal.
    const note = Array.from(document.querySelectorAll(
      'textarea#custom-message, textarea[name="message"], .send-invite textarea, [role="dialog"] textarea'
    )).find(visible);
    if (note) {
      const max = note.maxLength > 0 ? note.maxLength : null;
      setNativeValue(note, text);
      note.focus();
      return { success: true, target: 'note', maxLength: max, over: !!(max && text.length > max) };
    }

    // 2. Messaging composer (overlay bubble or full messaging page).
    const boxes = Array.from(document.querySelectorAll(
      '.msg-form__contenteditable[contenteditable="true"], [role="textbox"][contenteditable="true"]'
    )).filter(visible);
    const box = boxes[boxes.length - 1];
    if (box) {
      let body = text;
      const m = /^\s*subject:\s*(.+)\r?\n+/i.exec(text);
      const subjectInput = Array.from(document.querySelectorAll('input[name="subject"], .msg-form__subject')).find(visible);
      if (m && subjectInput) {
        setNativeValue(subjectInput, m[1].trim());
        body = text.slice(m[0].length);
      }
      box.focus();
      const range = document.createRange();
      range.selectNodeContents(box);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('insertText', false, body);
      if (!ok) {
        box.textContent = body;
        box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return { success: true, target: 'message' };
    }

    return { success: false, reason: 'no-target' };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ─── Floating "Write outreach" button ───────────────────────────────────────
  const HOST_ID = 'ark-outreach-fab';
  let fabEnabled = true;
  let lastHref = '';

  function mountFab() {
    document.getElementById(HOST_ID)?.remove(); // stale copy from a previous extension version
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;right:20px;bottom:76px;z-index:2147483000;display:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        button{all:unset;cursor:pointer;display:flex;align-items:center;gap:7px;padding:9px 14px 9px 11px;border-radius:999px;
          background:#1A56DB;color:#fff;font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
          box-shadow:0 4px 14px rgba(26,86,219,.35),0 1px 3px rgba(0,0,0,.2);transition:transform .15s,box-shadow .15s}
        button:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(26,86,219,.45),0 1px 3px rgba(0,0,0,.2)}
        button:focus-visible{outline:3px solid #93B4FF;outline-offset:2px}
        svg{width:15px;height:15px}
      </style>
      <button type="button" aria-label="Write an outreach message with Outreach AI" title="Outreach AI (Alt+Shift+O)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.8 1.9 1.9.8-1.9.8L19 20.5l-.8-1.9-1.9-.8 1.9-.8z"/></svg>
        Write outreach
      </button>`;
    root.querySelector('button').addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_PANEL' }, () => void chrome.runtime.lastError);
      } catch (_) {
        host.remove(); // extension was reloaded; this copy is orphaned
      }
    });
    document.documentElement.appendChild(host);
    return host;
  }

  let fab = null;
  function syncFab() {
    if (!fab || !fab.isConnected) fab = mountFab();
    fab.style.display = fabEnabled && currentSlug() ? 'block' : 'none';
  }

  try {
    chrome.storage.local.get(['showFab'], (r) => {
      fabEnabled = r?.showFab !== false;
      syncFab();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.showFab) { fabEnabled = changes.showFab.newValue !== false; syncFab(); }
    });
  } catch (_) { /* orphaned */ }

  // LinkedIn is a SPA: watch for URL changes.
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; syncFab(); }
  }, 700);
})();
