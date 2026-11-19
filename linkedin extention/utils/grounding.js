'use strict';

// utils/grounding.js — fact-check a generated message against what we actually read.
//
// The worst failure of AI outreach isn't a bland message, it's a confident false
// one ("Congrats on the promotion!" to someone who wasn't promoted), sent under your
// name to a stranger. This runs locally, instantly, with no extra AI call:
//   1. split the message into sentences (keeping character offsets for highlighting)
//   2. pull out checkable claims: proper names, numbers, and "event" words
//      (promotion, funding, talk, hiring, launch…)
//   3. look for each claim in the sources: their profile, Deep Mode research,
//      shared background, and the sender's own bio/profile
// A sentence is "backed" when every claim is found, "check" when any claim isn't,
// and "neutral" when it makes no factual claim ("Would you be open to a chat?").
// It is a heuristic and is labelled as such in the UI: it flags, it doesn't judge.

const Grounding = (() => {
  const STOP = new Set((
    'a an the and or but nor of to in on at for with from by as is are was were be been being it its this that these those ' +
    'i me my we our us you your yours he she they them their his her hi hello hey dear thanks thank regards best cheers ' +
    'would could should will can may might love like really just so very also too more most about into over after before up out ' +
    'if not no yes do does did done have has had am im ive id youre there here what when where who how which while than then ' +
    'some any all each own same other such only well much many quick chat call time week weeks connect connecting reach reaching ' +
    'team work working role recent recently great amazing exciting excited interesting impressive impressed love loved enjoyed ' +
    'reading read saw seen noticed came across profile background experience opportunity opportunities happy glad keen open ' +
    'learn learning hear hearing share sharing perspective insights journey space field area industry company thing things way'
  ).split(' '));

  // Words that start sentences or greetings and are capitalised for grammar, not because they're names.
  const COMMON_CAPS = new Set((
    'I Hi Hello Hey Dear Thanks Thank Best Cheers Regards Warm Kind Sincerely Congrats Congratulations Would Could Should ' +
    'Can Will Are Is Do Does Did Have Has Your You Our My We They Their This That These Those It Its Looking Love Loved ' +
    'Saw Noticed Really Great Happy Glad Hope Let Lets Let\'s Also Just Quick Subject Re PS P.S. Sorry Excited Curious ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September ' +
    'October November December LinkedIn Linkedin InMail DM Ok OK Yes No So And But Or If When While As After Before Since ' +
    "I'm I've I'd I'll Im Ive"
  ).split(' '));

  // Event claims that need evidence. Each group lists stems that count as evidence.
  const EVENTS = [
    { id: 'promotion',   claim: /\bpromot(ed|ion)\b/i,                                  evidence: /promot|new role|now (head|lead|director|vp)/i },
    { id: 'funding',     claim: /\b(rais(ed|ing)|funding|series [a-e]\b|seed round)/i,   evidence: /rais|fund|series [a-e]|seed|invest/i },
    { id: 'launch',      claim: /\blaunch(ed|ing)?\b/i,                                 evidence: /launch|release|ship/i },
    { id: 'talk',        claim: /\b(talk|keynote|spoke|speaking|presentation|panel)\b/i, evidence: /talk|keynote|spoke|speak|slides|present|panel|conference/i },
    { id: 'award',       claim: /\b(award|won|winning|prize)\b/i,                        evidence: /award|won|win|prize/i },
    { id: 'hiring',      claim: /\b(hiring|recruiting)\b/i,                              evidence: /hiring|hire|recruit|join us|open role/i },
    { id: 'publication', claim: /\b(article|paper|blog|podcast|book|newsletter)\b/i,     evidence: /article|paper|blog|podcast|book|newsletter|write|wrote|post/i },
    { id: 'acquisition', claim: /\bacqui(red|sition)\b/i,                               evidence: /acqui/i },
    { id: 'anniversary', claim: /\banniversary\b/i,                                     evidence: /anniversary|\d+ (yrs?|years)/i },
    { id: 'open-source', claim: /\bopen[- ]sourc/i,                                     evidence: /open[- ]?sourc|github/i },
    { id: 'new-role',    claim: /\b(new role|new job|just joined|recently joined|started at)\b/i, evidence: /present|joined|new role|started/i }
  ];

  // Durations that belong to the ask ("15 minutes"), not to facts about anyone.
  const ASK_NUMBER = /^(\d+)\s*-?\s*(min|mins|minutes?|hours?|hrs?|mo|months?|days?|weeks?)\b/i;

  function norm(s) {
    return String(s || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9%+#.\s]/g, ' ')
      .replace(/\.(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stem(w) {
    return w.replace(/(ing|ers|er|ed|es|s)$/, '');
  }

  function contentWords(s) {
    return norm(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  }

  // ─── Sources ────────────────────────────────────────────────────────────────
  /**
   * Build the evidence list. Each source: { id, owner: 'them'|'me'|'both'|'research', label, text }.
   */
  function buildSources({ profile, research, hooks, common, userBio, myProfile }) {
    const out = [];
    const add = (owner, label, text) => {
      const t = Array.isArray(text) ? text.filter(Boolean).join(' · ') : text;
      if (t && String(t).trim()) out.push({ id: out.length, owner, label, text: String(t), n: norm(t) });
    };
    const p = profile || {};
    add('them', 'Their name', p.name);
    add('them', 'Their headline', p.headline);
    add('them', 'Their current role', [p.currentTitle, p.currentCompany].filter(Boolean).join(' at '));
    add('them', 'Their location', p.location);
    add('them', 'Their About section', p.about);
    (p.recentPosts || []).forEach(t => add('them', 'Their recent post', t));
    (p.experienceEntries || []).forEach(e => add('them', 'Their experience', [e.title, e.company && `at ${e.company}`, e.duration, e.description].filter(Boolean).join(' ')));
    (p.educationEntries || []).forEach(t => add('them', 'Their education', t));
    add('them', 'Their skills', p.skills);
    add('them', 'Their past companies', p.pastCompanies);

    const r = research || {};
    const pj = r.profileJSON || {};
    add('research', 'Research summary', [pj.headline, pj.summary, pj.currentCompany].filter(Boolean));
    (hooks || []).forEach(h => add('research', 'Research hook', typeof h === 'string' ? h : h.text));
    (r.enrichmentJSON?.companyNews || []).forEach(n => add('research', 'Company news', [n?.headline, n?.relevance, n?.summary].filter(Boolean)));
    (r.enrichmentJSON?.publicWork || []).forEach(w => add('research', 'Public work', typeof w === 'string' ? w : [w?.title, w?.summary]));

    (common || []).forEach(c => add('both', 'Shared background', [c.text, c.detail].filter(Boolean)));

    add('me', 'Your bio', userBio);
    const m = myProfile || {};
    add('me', 'Your headline', m.headline);
    add('me', 'Your About section', m.about);
    (m.experienceEntries || []).forEach(e => add('me', 'Your experience', [e.title, e.company && `at ${e.company}`].filter(Boolean).join(' ')));
    (m.educationEntries || []).forEach(t => add('me', 'Your education', t));
    add('me', 'Your skills', m.skills);
    add('me', 'Your location', m.location);
    return out;
  }

  // ─── Sentences ──────────────────────────────────────────────────────────────
  function sentences(text) {
    const out = [];
    const re = /[^.!?\n]+(?:[.!?]+(?=\s|$)|$)|[^\n]+/g;
    // Split by lines first so "Subject:" lines and sign-offs stay separate.
    let offset = 0;
    for (const line of String(text || '').split('\n')) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        const raw = m[0];
        const lead = raw.length - raw.trimStart().length;
        const t = raw.trim();
        if (t) out.push({ text: t, start: offset + m.index + lead, end: offset + m.index + lead + t.length });
        if (re.lastIndex === m.index) re.lastIndex++;
      }
      offset += line.length + 1;
    }
    // Merge decimal/abbreviation splits ("Ph.", "4.5") into the previous sentence.
    return out.filter(s => s.text.length > 1);
  }

  // ─── Claims ─────────────────────────────────────────────────────────────────
  function extractClaims(sentence, { ignoreNames }) {
    const claims = [];
    const text = sentence.replace(/^subject:\s*/i, '');
    const ignore = new Set(ignoreNames.map(norm).filter(Boolean));

    // Proper-noun phrases: runs of Capitalised / ACRONYM / mixedCase tokens, allowing "of", "&", "de".
    const tokens = [...text.matchAll(/[A-Za-z0-9][\w&+#.'’-]*/g)].map(m => ({ w: m[0].replace(/[.'’]+$/, ''), i: m.index }));
    let run = [];
    const flush = () => {
      while (run.length && /^(of|and|&|de|for|the)$/i.test(run[run.length - 1].w)) run.pop();
      // A lone, ordinary capitalised word at the start of a sentence is grammar ("Open to…").
      if (run.length === 1 && run[0].sentenceStart && /^[A-Z][a-z]+$/.test(run[0].w)) run = [];
      if (run.length) {
        const phrase = run.map(t => t.w).join(' ');
        const n = norm(phrase);
        const allIgnored = run.every(t => ignore.has(norm(t.w)) || COMMON_CAPS.has(t.w));
        if (!allIgnored && !ignore.has(n) && n.length > 1) {
          // Trim leading grammar-caps ("Congrats Lumen Analytics" → "Lumen Analytics").
          const firstReal = run.findIndex(t => !COMMON_CAPS.has(t.w) && !ignore.has(norm(t.w)));
          const kept = run.slice(firstReal).map(t => t.w).filter(w => !ignore.has(norm(w)));
          if (kept.length) claims.push({ kind: 'name', value: kept.join(' ') });
        }
      }
      run = [];
    };
    tokens.forEach((t, idx) => {
      const isCap = /^[A-Z]/.test(t.w) || /[a-z][A-Z]/.test(t.w);
      const connector = run.length && /^(of|and|&|de|for)$/i.test(t.w);
      const firstWord = idx === 0 || /[.!?:]\s*$/.test(text.slice(0, t.i));
      if ((isCap && !(firstWord && COMMON_CAPS.has(t.w)) && !(t.w === 'I')) || connector) run.push({ ...t, sentenceStart: firstWord });
      else flush();
    });
    flush();

    // Numbers that describe facts (not "15 minutes").
    for (const m of text.matchAll(/\b\d[\d,.]*\s*(%|k\b|m\b|bn\b|x\b|\+)?(\s*[a-z]+)?/gi)) {
      if (ASK_NUMBER.test(m[0].trim())) continue;
      const num = m[0].match(/\d[\d,.]*/)[0].replace(/[.,]$/, '');
      claims.push({ kind: 'number', value: num, display: m[0].trim() });
    }

    // Events.
    for (const e of EVENTS) {
      const m = e.claim.exec(text);
      if (m) claims.push({ kind: 'event', value: m[0], event: e });
    }

    // De-duplicate.
    const seen = new Set();
    return claims.filter(c => {
      const k = c.kind + ':' + norm(c.value);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ─── Matching ───────────────────────────────────────────────────────────────
  function findName(value, sources) {
    const n = norm(value);
    // Exact phrase.
    let best = sources.find(s => (' ' + s.n + ' ').includes(' ' + n + ' '));
    if (best) return { source: best, term: value };
    // All significant words in the same source (handles "Lumen" ↔ "Lumen Analytics", plurals).
    const words = n.split(' ').filter(w => w.length >= 2 && !STOP.has(w));
    if (!words.length) return { source: null };
    best = sources.find(s => {
      const bag = new Set(s.n.split(' ').map(stem));
      return words.every(w => bag.has(stem(w)) || s.n.includes(w));
    });
    return { source: best || null, term: value };
  }

  function findNumber(value, sources) {
    const digits = value.replace(/[,]/g, '');
    const src = sources.find(s => s.n.replace(/,/g, '').match(new RegExp(`(^|[^\\d])${digits.replace('.', '\\.')}([^\\d]|$)`)));
    return { source: src || null, term: value };
  }

  function findEvent(claim, sentence, sources) {
    const words = new Set(contentWords(sentence).map(stem));
    let best = null, bestScore = 0;
    for (const s of sources) {
      if (!claim.event.evidence.test(s.text)) continue;
      const overlap = contentWords(s.text).map(stem).filter(w => words.has(w)).length;
      const score = 1 + overlap;
      if (score > bestScore) { best = s; bestScore = score; }
    }
    return { source: best, term: claim.value };
  }

  function snippet(source, term) {
    const t = source.text;
    const idx = t.toLowerCase().indexOf(String(term || '').toLowerCase());
    if (idx < 0 || t.length <= 120) return t.length > 140 ? t.slice(0, 137) + '…' : t;
    const start = Math.max(0, idx - 50);
    const end = Math.min(t.length, idx + term.length + 60);
    return (start ? '…' : '') + t.slice(start, end).trim() + (end < t.length ? '…' : '');
  }

  // ─── Public ─────────────────────────────────────────────────────────────────
  /**
   * @returns {{ sentences: Array, backed: number, unverified: number, specificsAboutThem: number }}
   */
  function check(text, ctx) {
    const sources = buildSources(ctx);
    const recipient = ctx.profile?.name || '';
    const sender = ctx.userName || ctx.myProfile?.name || '';
    const ignoreNames = [...recipient.split(/\s+/), recipient, ...sender.split(/\s+/), sender].filter(w => w && w.length > 1);

    const result = { sentences: [], backed: 0, unverified: 0, specificsAboutThem: 0, sources };
    for (const s of sentences(text)) {
      // Greeting lines and sign-offs are never claims.
      if (/^(hi|hello|hey|dear)(\s+[\w'’-]+){0,3}\s*[,!.]?$/i.test(s.text) ||
          /^(best|thanks|thank you|cheers|regards|warmly|sincerely|all the best|kind regards)(\s+[\w'’-]+){0,3}\s*[,!.]?$/i.test(s.text) ||
          (sender && norm(s.text) === norm(sender))) {
        result.sentences.push({ ...s, status: 'neutral', claims: [] });
        continue;
      }
      // "I spoke at…" is a claim about the sender: only the sender's own data can back it.
      const aboutSender = /^(i|i'm|im|i am|i've|ive|my|we|our)\b/i.test(s.text) && !/\byou(r|'re|’re)?\b/i.test(s.text);
      const pool = aboutSender ? sources.filter(x => x.owner === 'me' || x.owner === 'both') : sources;
      const claims = extractClaims(s.text, { ignoreNames }).map(c => {
        const hit = c.kind === 'name' ? findName(c.value, pool)
          : c.kind === 'number' ? findNumber(c.value, pool)
          : findEvent(c, s.text, pool);
        return { ...c, found: !!hit.source, source: hit.source ? { owner: hit.source.owner, label: hit.source.label, snippet: snippet(hit.source, hit.term) } : null };
      });
      const missing = claims.filter(c => !c.found);
      const status = !claims.length ? 'neutral' : missing.length ? 'unverified' : 'backed';
      if (status === 'backed') result.backed++;
      if (status === 'unverified') result.unverified++;
      result.specificsAboutThem += claims.filter(c => c.found && ['them', 'research', 'both'].includes(c.source.owner)).length;
      result.sentences.push({ ...s, status, claims, missing, aboutSender });
    }
    return result;
  }

  return { check, sentences, extractClaims, buildSources, norm };
})();

if (typeof module !== 'undefined') module.exports = Grounding;
