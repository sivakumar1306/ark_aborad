'use strict';

// utils/names.js — turn a LinkedIn display name into what you'd actually call someone.
// "Dr. Sheena Christabel Pravin" → first "Sheena", formal "Dr. Pravin".
// "Rahul Verma, PhD" → "Rahul". "Er. Anil Kumar (He/Him)" → "Anil".

const Names = (() => {
  const HONORIFIC = /^(dr|prof|professor|mr|mrs|ms|miss|mx|er|engr|adv|ca|cs|sir|dame|rev|hon|capt|col|lt|maj|gen|shri|sri|smt|kumari|sh)\.?$/i;
  const SUFFIX = /^(ph\.?\s?d\.?|mba|md|ms|msc|cfa|cpa|pmp|jr\.?|sr\.?|ii|iii|iv|esq\.?)$/i;

  // Strip pronouns, emoji, bracketed bits and ", PhD"-style credentials.
  function parts(name) {
    const clean = String(name || '')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/,.*$/, ' ')
      .replace(/[^\p{L}\p{M}\s.'’-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const words = clean.split(' ').filter(Boolean);
    const titles = [];
    while (words.length > 1 && HONORIFIC.test(words[0])) titles.push(words.shift());
    while (words.length > 1 && SUFFIX.test(words[words.length - 1])) words.pop();
    return { titles, words };
  }

  function first(name) {
    return parts(name).words[0] || 'there';
  }

  function last(name) {
    const w = parts(name).words;
    return w.length > 1 ? w[w.length - 1] : (w[0] || '');
  }

  // A doctor or professor, addressed formally, is "Dr. Pravin"; everyone else by first name.
  function greeting(name, tone) {
    const { titles, words } = parts(name);
    const title = titles.find(t => /^(dr|prof|professor)\.?$/i.test(t));
    if (tone === 'Formal' && title && words.length > 1) {
      const t = /^prof/i.test(title) ? 'Prof.' : 'Dr.';
      return `${t} ${words[words.length - 1]}`;
    }
    return words[0] || 'there';
  }

  function initials(name) {
    const w = parts(name).words;
    return ((w[0]?.[0] || '?') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
  }

  return { first, last, greeting, initials, parts };
})();

if (typeof module !== 'undefined') module.exports = Names;
