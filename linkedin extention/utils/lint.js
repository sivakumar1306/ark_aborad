'use strict';

// utils/lint.js — the "would a human roll their eyes?" check.
// Instant, local, deterministic. Each issue can be handed to "Fix with AI".

const Lint = (() => {
  const CLICHES = [
    [/\bI came across your (linkedin )?profile\b/i, 'I came across your profile', 'Open with something specific about them instead.'],
    [/\bI hope (this|my) (message|note|email) finds you well\b/i, 'I hope this finds you well', 'Filler. Cut it.'],
    [/\bhope you('| a)re (doing )?well\b/i, 'Hope you’re doing well', 'Filler in a short note.'],
    [/\bI (am|'m) (reaching|writing) (out )?to\b|\bI wanted to reach out\b/i, 'I’m reaching out to…', 'Say why directly.'],
    [/\bpick your brain\b/i, 'pick your brain', 'Ask a concrete question instead.'],
    [/\btouch base\b/i, 'touch base', 'Corporate filler.'],
    [/\bsynerg(y|ies)\b/i, 'synergy', 'Corporate filler.'],
    [/\bimpressive (profile|background|experience)\b|\bimpressed (by|with) your (profile|background|experience)\b/i, 'impressed by your profile', 'Generic praise. Name what impressed you.'],
    [/\bto whom it may concern\b|\bdear (sir|madam|sir\/madam)\b/i, 'Dear Sir/Madam', 'Use their name.'],
    [/\b(leverage|value[- ]add|circle back|win-win)\b/i, 'business jargon', 'Plain words read as more human.'],
    [/\bI would be (honored|honoured|grateful) if\b/i, 'I would be honored if…', 'Overly formal for LinkedIn.'],
    [/\bpassionate about\b/i, 'passionate about', 'Overused. Show it with a detail instead.']
  ];

  const ASK = /\?|\b(would you|could you|are you open|open to|happy to|mind if|let me know|keen to|love to (chat|connect|hear)|can we|shall we|up for)\b/i;

  /**
   * @param {string} text
   * @param {{ format:string, recipientName?:string, grounding?:object, userName?:string }} ctx
   * @returns {Array<{id:string, level:'error'|'warn'|'tip', title:string, detail:string, match?:string}>}
   */
  function check(text, ctx = {}) {
    const issues = [];
    const t = String(text || '');
    if (!t.trim()) return issues;
    const body = t.replace(/^\s*subject:.*\n+/i, '');

    // Placeholders the model forgot to fill.
    const ph = t.match(/\[[^\]\n]{1,40}\]|\{\{?[^}\n]{1,40}\}?\}|<(name|company|role|your name)>|\bXX+\b/i);
    if (ph) issues.push({ id: 'placeholder', level: 'error', title: `Placeholder left in: ${ph[0]}`, detail: 'Fill it in or remove it before sending.', match: ph[0] });

    // Greeting with the wrong name. Embarrassing and common.
    const first = String(ctx.recipientName || '').split(/\s+/)[0];
    const greet = body.match(/^\s*(?:hi|hello|hey|dear)\s+([A-Z][\w'-]+)/i);
    if (first && greet && greet[1].toLowerCase() !== first.toLowerCase() && !/^(there|team|all)$/i.test(greet[1])) {
      issues.push({ id: 'wrong-name', level: 'error', title: `Greets “${greet[1]}”, but this is ${first}`, detail: 'Wrong name in the greeting.', match: greet[1] });
    }

    // Subject line for InMail / email.
    if ((ctx.format === 'inmail' || ctx.format === 'email') && !/^\s*subject:/i.test(t)) {
      issues.push({ id: 'no-subject', level: 'warn', title: 'No subject line', detail: `${ctx.format === 'email' ? 'Emails' : 'InMails'} need one. Start with “Subject: …”.` });
    }

    for (const [re, label, detail] of CLICHES) {
      const m = t.match(re);
      if (m) issues.push({ id: 'cliche:' + label, level: 'warn', title: `Cliché: “${label}”`, detail, match: m[0] });
    }

    // Nothing specific about them (grounding counts verified claims about the recipient).
    if (ctx.grounding && ctx.grounding.specificsAboutThem === 0) {
      issues.push({ id: 'generic', level: 'warn', title: 'Nothing specific about them', detail: 'Mention a post, project or shared background. Specifics get replies.' });
    }

    // Unverified claims are listed by the fact check; summarise for "Fix with AI".
    if (ctx.grounding && ctx.grounding.unverified > 0) {
      issues.push({ id: 'unverified', level: 'warn', title: `${ctx.grounding.unverified} claim${ctx.grounding.unverified > 1 ? 's' : ''} not found in what we read`, detail: 'Check them, or let AI rewrite without them.', hidden: true });
    }

    // No ask.
    if (!ASK.test(body)) {
      issues.push({ id: 'no-ask', level: 'tip', title: 'No clear ask', detail: 'End with a light question, e.g. “Open to a quick chat?”' });
    }

    // All about the sender.
    const sents = body.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 3 && !/^(hi|hello|hey|dear|best|thanks|cheers|regards)\b/i.test(s));
    const selfish = sents.filter(s => /^(i|i'm|i’m|i am|i've|my)\b/i.test(s)).length;
    if (sents.length >= 3 && selfish / sents.length > 0.5) {
      issues.push({ id: 'me-me-me', level: 'tip', title: 'Mostly about you', detail: `${selfish} of ${sents.length} sentences start with “I” or “my”. Lead with them.` });
    }

    const bangs = (body.match(/!/g) || []).length;
    if (bangs > 2) issues.push({ id: 'exclaim', level: 'tip', title: `${bangs} exclamation marks`, detail: 'One is plenty.' });

    return issues;
  }

  return { check };
})();

if (typeof module !== 'undefined') module.exports = Lint;
