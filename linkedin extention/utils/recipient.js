'use strict';

// utils/recipient.js — who is this person, and what can they realistically help with?
//
// Asking a student about "roles on your team" or a recruiter for "career advice"
// reads as careless, however well it's written. This classifies the recipient from
// their headline and current title (locally, instantly), suggests the purpose that
// fits, warns when the chosen purpose doesn't, and gives the writers guidance.

const Recipient = (() => {
  const TYPES = {
    recruiter:    { label: 'Recruiter',          icon: '🧲', article: 'a recruiter',
                    purpose: 'Job',
                    guidance: 'They recruit, so be direct about the kind of role you want and ask about openings.' },
    student:      { label: 'Student',            icon: '🎓', article: 'a student',
                    purpose: 'Networking',
                    guidance: 'They are a student, so they cannot hire or refer. Ask to connect, swap notes or hear about their experience; do not ask about roles on their team.' },
    leader:       { label: 'Team lead / manager', icon: '🧭', article: 'a team lead or manager',
                    purpose: 'Job',
                    guidance: 'They lead a team, so a brief question about what their team looks for, or whether it is hiring, fits.' },
    founder:      { label: 'Founder',            icon: '🚀', article: 'a founder',
                    purpose: 'Networking',
                    guidance: 'They are a founder: keep it short and show genuine interest in what they are building.' },
    senior:       { label: 'Senior engineer',    icon: '🛠', article: 'an experienced engineer',
                    purpose: 'Advice',
                    guidance: 'They are an experienced individual contributor, usually not the one hiring: ask for advice or a short chat; ask for a referral only if that is the purpose.' },
    professional: { label: 'Professional',       icon: '💼', article: 'a professional',
                    purpose: 'Networking',
                    guidance: 'Keep the ask small and specific to their work.' }
  };

  // Order matters: the first rule that matches wins.
  const RULES = [
    ['recruiter', /\b(recruit\w*|talent acquisition|talent partner|sourcer|technical recruiter|hr business partner|human resources|people partner|hiring specialist)\b/i],
    ['student',   /\b(student|undergrad\w*|pursuing|fresher|class of 20\d\d|b\.?\s?tech|m\.?\s?tech|bachelor'?s|master'?s|ph\.?d\.? (student|candidate|scholar)|aspiring|graduate)\b/i],
    ['founder',   /\b(co-?founder|founder|ceo|entrepreneur|owner)\b/i],
    ['leader',    /\b(engineering manager|manager|head of|director|vp|vice president|cto|cpo|chief|team lead|tech lead|lead\b)/i],
    ['senior',    /\b(senior|sr\.?|staff|principal|architect|sde[\s-]?(ii|iii|2|3)|l[5-7]\b)/i],
    ['professional', /\b(engineer|developer|scientist|analyst|designer|consultant|researcher|product|marketing|specialist|associate|intern)\b/i]
  ];

  /** @returns {{type:string, label:string, icon:string, article:string, purpose:string, guidance:string, why:string}|null} */
  function classify(p = {}) {
    // The current title is the strongest signal; the headline adds context.
    const sources = [['title', p.currentTitle], ...(p.currentRoles || []).map(r => ['role', r.title]), ['headline', p.headline]].filter(([, v]) => v);
    for (const [type, re] of RULES) {
      for (const [where, text] of sources) {
        const m = re.exec(text);
        if (m) {
          // "Intern" alone is early-career; treat like a student for what they can help with.
          const t = type === 'professional' && /^intern$/i.test(m[0]) ? 'student' : type;
          return { type: t, ...TYPES[t], why: `${where}: “${matchContext(text, m.index, m[0].length)}”` };
        }
      }
    }
    return p.headline || p.currentTitle ? { type: 'professional', ...TYPES.professional, why: '' } : null;
  }

  function matchContext(text, i, len) {
    const parts = String(text).split(/\s*[|·•]\s*/);
    let pos = 0;
    for (const part of parts) {
      const at = text.indexOf(part, pos);
      if (i >= at && i < at + part.length) return part.trim().slice(0, 60);
      pos = at + part.length;
    }
    return text.slice(Math.max(0, i - 10), i + len + 10).trim();
  }

  /** The purpose that fits this recipient. */
  function suggestPurpose(r) {
    return r ? r.purpose : 'Networking';
  }

  /** A warning when the chosen purpose doesn't fit who they are, or null. */
  function mismatch(r, purpose, firstName = 'They') {
    if (!r || !purpose || purpose === 'Auto') return null;
    const f = firstName || 'They';
    if (r.type === 'student' && (purpose === 'Job' || purpose === 'Referral')) {
      return { suggest: 'Networking', reason: `${f} looks like a student, so they likely can’t help with roles or referrals. Networking fits better.` };
    }
    if (r.type === 'recruiter' && (purpose === 'Advice' || purpose === 'Collaboration')) {
      return { suggest: 'Job', reason: `${f} is a recruiter. They’re the right person to ask about openings.` };
    }
    if ((r.type === 'senior' || r.type === 'professional') && purpose === 'Job') {
      return { suggest: 'Advice', reason: `${f} probably doesn’t hire directly. Ask for advice, or pick Referral if you want one.` };
    }
    if (r.type === 'leader' && purpose === 'Referral') {
      return { suggest: 'Job', reason: `${f} leads a team, so asking about openings directly fits better than a referral.` };
    }
    return null;
  }

  return { classify, suggestPurpose, mismatch, TYPES };
})();

if (typeof module !== 'undefined') module.exports = Recipient;
