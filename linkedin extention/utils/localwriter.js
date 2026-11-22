'use strict';

// utils/localwriter.js — Free mode: messages written on-device, no API key, no cost.
//
// Upstream's free template always opened with "I came across your profile and was
// impressed by your work…", ignored LinkedIn's limits, and gave the same text every
// time. This writer only ever uses facts from the scraped profile (so the fact check
// passes by construction), leads with the strongest specific thing available
// (shared background → their post → selected hook → their role), fits the format's
// hard limit, and rotates openers so "Write another version" gives a real alternative.

const LocalWriter = (() => {
  const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

  function topic(post, max = 60) {
    let t = String(post || '').replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
    t = t.split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, '');
    if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '') + '…';
    return t;
  }

  // Hooks for Deep mode without a key: profile-derived, each a plain sentence.
  function hooks(p = {}) {
    const out = [];
    if (p.recentPosts?.[0]) out.push({ kind: 'post', text: `Recently posted: “${topic(p.recentPosts[0], 90)}”` });
    if (p.recentPosts?.[1]) out.push({ kind: 'post2', text: `Also posted: “${topic(p.recentPosts[1], 90)}”` });
    if (p.currentTitle && p.currentCompany) out.push({ kind: 'role', text: `Works as ${p.currentTitle} at ${p.currentCompany}` });
    const past = (p.experienceEntries || []).slice(1).find(e => e.company && e.company !== p.currentCompany);
    if (past) out.push({ kind: 'past', text: `Previously ${past.title ? `${past.title} at ` : 'at '}${past.company}`, company: past.company, title: past.title });
    const school = String(p.educationEntries?.[0] || '').split(' — ')[0];
    if (school) out.push({ kind: 'school', text: `Studied at ${school}`, school });
    if (p.skills?.length) out.push({ kind: 'skills', text: `Lists ${p.skills.slice(0, 3).join(', ')} as skills` });
    return out.slice(0, 6);
  }

  // Turn a common-ground line ("You both studied at X") into a first-person opener.
  function commonOpener(text, firstName) {
    let m;
    if ((m = /^You both studied at (.+)$/.exec(text))) return { short: `fellow ${m[1]} alum here!`, long: `I noticed we’re both ${m[1]} alumni.`, subject: `Fellow ${m[1]} alum` };
    if ((m = /^You both work at (.+)$/.exec(text))) return { short: `we’re both at ${m[1]}!`, long: `I noticed we’re both at ${m[1]}.`, subject: `Fellow ${m[1]} colleague` };
    if ((m = /^You've both worked at (.+)$/.exec(text))) return { short: `we’ve both spent time at ${m[1]}.`, long: `I saw we’ve both spent time at ${m[1]}.`, subject: `${m[1]} alumni` };
    if ((m = new RegExp(`^${firstName} used to work at (.+), where you work now$`).exec(text))) return { short: `I’m at ${m[1]} now, where you used to be.`, long: `I’m at ${m[1]} now and saw you used to be there too.`, subject: `From ${m[1]}` };
    if ((m = new RegExp(`^${firstName} works at (.+), where you've worked$`).exec(text))) return { short: `I used to be at ${m[1]} too.`, long: `I used to be at ${m[1]} myself.`, subject: `${m[1]} alumni` };
    if ((m = /^You're both based in (.+)$/.exec(text))) return { short: `fellow ${m[1]} local here.`, long: `I’m based in ${m[1]} too.`, subject: `Hello from ${m[1]}` };
    if ((m = /^You both list (.+?)( as a skill)?$/.exec(text))) return { short: `we both work with ${m[1]}.`, long: `I saw we both work with ${m[1]}.`, subject: `${m[1].split(/,| and /)[0]}` };
    return null;
  }

  function openers({ profile: p, common = [], hooks: picked = [], recipientType = null }) {
    const f = first(p.name);
    const list = [];
    for (const c of common) {
      const o = commonOpener(c, f);
      if (o) list.push({ ...o, kind: 'common' });
    }
    const kinds = new Set(picked.map(h => h.kind));
    const usePost = p.recentPosts?.[0] && (!picked.length || kinds.has('post'));
    if (usePost) {
      const t = topic(p.recentPosts[0], 55);
      list.push({ kind: 'post', short: `your post “${t}” stuck with me.`, long: `Your recent post, “${topic(p.recentPosts[0], 90)}”, stuck with me.`, subject: `Your post on ${topic(p.recentPosts[0], 30)}` });
    }
    for (const h of picked) {
      if (h.kind === 'web' && h.text) {
        const s = h.text.replace(/\.$/, '');
        list.push({ kind: 'web', short: `I saw that ${lower(s)}.`, long: `I saw that ${lower(s)}.`, subject: 'Congrats on the news' });
      }
      if (h.kind === 'past' && h.company) list.push({ kind: 'past', short: `your path from ${h.company} to ${p.currentCompany || 'your current role'} caught my eye.`, long: `Your path from ${h.company} to ${p.currentCompany || 'your current role'} caught my eye.`, subject: `Your path from ${h.company}` });
      if (h.kind === 'school' && h.school) list.push({ kind: 'school', short: `I saw you studied at ${h.school}.`, long: `I saw you studied at ${h.school}.`, subject: `Question from a fellow student` });
    }
    const type = recipientType;
    if (type === 'student' && (p.currentTitle || p.headline)) {
      // "Computer Science Student" → "Computer Science"; the school is usually the "company".
      const field = String(p.currentTitle || p.headline).split(/\s*[|·@]\s*|\s+at\s+/i)[0].replace(/\b(student|undergrad\w*|aspiring)\b/ig, '').replace(/\s+/g, ' ').trim();
      const where = p.currentCompany ? ` at ${p.currentCompany}` : '';
      const what = field ? `studying ${field}${where}` : `a student${where}`;
      list.push({ kind: 'role', short: `I saw you’re ${what}.`, long: `I saw you’re ${what}.`, subject: `Hello from a fellow student` });
    } else if (type === 'recruiter' && p.currentCompany) {
      list.push({ kind: 'role', short: `I saw you recruit for ${p.currentCompany}.`, long: `I saw you recruit for ${p.currentCompany}.`, subject: `Interested in roles at ${p.currentCompany}` });
    } else if (p.currentTitle && p.currentCompany) {
      list.push({ kind: 'role', short: `your work as ${p.currentTitle} at ${p.currentCompany} caught my eye.`, long: `Your work as ${p.currentTitle} at ${p.currentCompany} caught my eye.`, subject: `Quick question about ${p.currentCompany}` });
    } else if (p.headline) {
      list.push({ kind: 'headline', short: `your focus on ${lower(topic(p.headline, 50))} caught my eye.`, long: `Your focus on ${lower(topic(p.headline, 70))} caught my eye.`, subject: 'Quick question' });
    }
    return list;
  }

  function lower(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

  // "I’m Sam (final-year CS student into ML infra)." Parentheses keep any bio grammatical.
  function senderLine(name, bio, max) {
    const f = name ? first(name) : '';
    let b = String(bio || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, '');
    if (b.length > max) b = b.slice(0, max).replace(/[\s,;:]+\S*$/, '');
    if (!b) return f ? `I’m ${f}.` : '';
    if (/^(I|I'm|I’m|I am)\b/.test(b)) return f ? `I’m ${f}. ${b}.` : `${b}.`;
    return f ? `I’m ${f} (${b}).` : `${b}.`;
  }

  const ASKS = {
    Networking:    { short: 'Would love to connect!', long: 'Would you be open to connecting? I’d love to hear how you got to where you are.' },
    Job:           { short: 'Open to a quick chat about roles on your team?', long: 'Would you be open to a quick chat about roles on your team? Even 15 minutes would help a lot.' },
    Referral:      { short: 'Open to a quick chat about roles at {company}?', long: 'Would you be open to a quick chat about roles at {company}? If it feels like a fit afterwards, I’d be grateful for a referral.' },
    Collaboration: { short: 'Open to exploring a collaboration?', long: 'Would you be open to a short call to explore working together?' },
    Advice:        { short: 'Could I ask you one quick question about your path?', long: 'Would you be open to sharing one piece of advice for someone starting out in your field? Even a couple of lines would help a lot.' }
  };

  // The same purpose needs a different ask depending on who they are.
  const ASK_BY_TYPE = {
    student:   { Networking: { short: 'Would love to connect and swap notes!', long: 'Would love to connect and swap notes on what we’re each working on.' } },
    recruiter: { Job: { short: 'Open to a quick chat about openings at {company}?', long: 'Would you be open to a quick chat about openings at {company} that might fit my background?' } },
    leader:    { Job: { short: 'Is your team hiring? I’d love to hear what you look for.', long: 'Is your team hiring at the moment? I’d love to hear what you look for in new people.' } }
  };

  const GREET = { Formal: (f) => `Dear ${f},`, Neutral: (f) => `Hi ${f},`, Casual: (f) => `Hey ${f}!` };
  const CLOSE = { Formal: 'Kind regards,', Neutral: 'Best,', Casual: 'Cheers,' };

  /**
   * ctx: { profile, sender:{name,bio}, common:[string], hooks:[{kind,text,...}], purpose, tone, format, noteLimit, variant, shorten }
   */
  function write(ctx) {
    const p = ctx.profile || {};
    const f = first(p.name);
    const fmt = Formats.get(ctx.format, { noteLimit: ctx.noteLimit || 300 });
    const tone = GREET[ctx.tone] ? ctx.tone : 'Neutral';
    const ask = ASK_BY_TYPE[ctx.recipientType]?.[ctx.purpose] || ASKS[ctx.purpose] || ASKS.Networking;
    const fill = (s) => s.replace('{company}', p.currentCompany || 'your company');
    const ops = openers({ profile: p, common: ctx.common || [], hooks: ctx.hooks || [], recipientType: ctx.recipientType });
    const op = ops.length ? ops[(ctx.variant || 0) % ops.length] : { short: 'I’d love to learn more about your work.', long: 'I’d love to learn more about your work.', subject: 'Quick question' };
    const second = ops.length > 1 ? ops[((ctx.variant || 0) + 1) % ops.length] : null;

    if (fmt.id === 'note') {
      const limit = Math.floor((ctx.shorten ? 0.75 : 1) * fmt.limit);
      const greet = tone === 'Casual' ? `Hey ${f}, ` : tone === 'Formal' ? `Dear ${f}, ` : `Hi ${f}, `;
      const candidates = [
        [greet + op.short, senderLine(ctx.sender?.name, ctx.sender?.bio, 60), fill(ask.short)],
        [greet + op.short, senderLine(ctx.sender?.name, '', 0), fill(ask.short)],
        [greet + op.short, fill(ask.short)],
        [greet + op.short, 'Would love to connect!']
      ];
      for (const parts of candidates) {
        const t = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        if (t.length <= limit) return t;
      }
      return Formats.fit(candidates[candidates.length - 1].join(' '), 'note', { noteLimit: limit });
    }

    const lines = [];
    if (fmt.subject) lines.push(`Subject: ${op.subject}`, '');
    lines.push(GREET[tone](f), '');
    const body = [op.long];
    if (!ctx.shorten && second && second.kind !== op.kind) body.push(second.long);
    const me = senderLine(ctx.sender?.name, ctx.sender?.bio, ctx.shorten ? 80 : 160);
    if (me) body.push(me);
    lines.push(body.join(' '), '');
    lines.push(fill(ctx.shorten ? ask.short : ask.long), '');
    lines.push(CLOSE[tone] + (ctx.sender?.name ? `\n${ctx.sender.name}` : ''));
    let text = lines.join('\n').trim();
    if (fmt.limit && text.length > fmt.limit) text = Formats.fit(text, fmt.id);
    return text;
  }

  return { write, hooks, openers };
})();

if (typeof module !== 'undefined') module.exports = LocalWriter;
