'use strict';

// utils/formats.js — where the message will be sent, and what that implies.
//
// LinkedIn enforces hard limits (an invite note is 200 chars on free accounts,
// 300 on Premium). The server's API predates formats, so the requirements travel
// as a short written brief appended to the sender bio (which the server already
// feeds to the model), plus explicit `format` / `maxChars` fields for when the
// server learns to read them.

const Formats = (() => {
  const DEFS = {
    note:   { id: 'note',   label: 'Note',   name: 'LinkedIn connection request note', limit: 300,  target: 300, subject: false,
              desc: 'Invite note. 200 characters on free accounts, 300 on Premium.' },
    dm:     { id: 'dm',     label: 'DM',     name: 'LinkedIn direct message',           limit: 8000, target: 600, subject: false,
              desc: 'For people you’re already connected with. Best under 600 characters.' },
    inmail: { id: 'inmail', label: 'InMail', name: 'LinkedIn InMail',                   limit: 1900, target: 900, subject: true,
              desc: 'Subject line + body. Body max 1,900 characters.' },
    email:  { id: 'email',  label: 'Email',  name: 'cold email',                        limit: null, target: 1200, subject: true,
              desc: 'Subject line + body, for when you have their email address.' }
  };

  // noteLimit: 200 (free) or 300 (Premium).
  function get(id, { noteLimit = 300 } = {}) {
    const f = DEFS[id] || DEFS.note;
    if (f.id !== 'note') return f;
    return { ...f, limit: noteLimit, target: noteLimit };
  }

  function list() { return Object.values(DEFS); }

  function brief({ format, context, shorten, previous, noteLimit, hooks }) {
    const f = get(format, { noteLimit });
    const lines = [`Output format: ${f.name}.`];
    if (f.id === 'note') {
      lines.push(`HARD LIMIT: the entire message must be at most ${f.limit} characters including spaces. No subject line, no greeting line break padding, no placeholders like [Name].`);
    } else if (f.subject) {
      lines.push(`First line must be "Subject: <subject>", then a blank line, then the body. Keep the body under ${f.target} characters.`);
    } else {
      lines.push(`Keep it under ${f.target} characters. No subject line, no placeholders.`);
    }
    if (hooks === 0) lines.push('Do not reference company news or recent events.');
    if (context && context.trim()) lines.push(`Extra context from the sender. Use it naturally and accurately: ${context.trim()}`);
    if (shorten) {
      const goal = Math.round((f.id === 'note' ? f.limit : f.target) * 0.75);
      lines.push(`The previous draft was too long. Write a clearly shorter version (aim for about ${goal} characters)` +
        (previous ? ` that keeps its best point. Previous draft: """${previous.slice(0, 1500)}"""` : '.'));
    }
    return lines.join('\n');
  }

  function split(text) {
    const m = /^\s*subject:\s*(.+)\r?\n+/i.exec(text || '');
    return m ? { subject: m[1].trim(), body: text.slice(m[0].length) } : { subject: null, body: text || '' };
  }

  function measure(text, formatId, opts) {
    const f = get(formatId, opts);
    const { subject, body } = f.subject ? split(text) : { subject: null, body: text || '' };
    const n = body.length;
    let level = 'ok';
    if (f.limit && n > f.limit) level = 'over';
    else if (n > f.target) level = 'warn';
    const scale = f.limit && f.id !== 'dm' ? f.limit : f.target * 1.4;
    return { n, limit: f.limit, target: f.target, level, subject, pct: Math.min(1, n / scale), format: f };
  }

  // Trim to the last sentence that fits; fall back to a word boundary.
  function fit(text, formatId, opts) {
    const f = get(formatId, opts);
    const max = f.limit || f.target;
    const { subject, body } = f.subject ? split(text) : { subject: null, body: text };
    if (body.length <= max) return text;
    const cut = body.slice(0, max);
    const ends = [...cut.matchAll(/[.!?](?=\s|$)/g)].map(m => m.index);
    const lastEnd = ends.length ? ends[ends.length - 1] : -1;
    let out;
    if (lastEnd > max * 0.5) out = cut.slice(0, lastEnd + 1).trim();
    else {
      const sp = cut.lastIndexOf(' ');
      out = cut.slice(0, sp > 0 ? sp : max - 1).replace(/[,;:\-–—\s]+$/, '').trim() + '…';
    }
    return subject ? `Subject: ${subject}\n\n${out}` : out;
  }

  return { get, list, brief, measure, fit, split };
})();
