'use strict';

// utils/common.js — shared background between you and the person you're writing to.
//
// "We both studied at IIT Bombay" beats any AI-written opener, and it's free: both
// profiles are already on this device. Matching is fuzzy enough for real LinkedIn
// data ("IIT Bombay" ↔ "Indian Institute of Technology, Bombay", "Zalando SE" ↔ "Zalando").

const CommonGround = (() => {
  const ORG_NOISE = new Set(['the', 'of', 'and', 'at', 'university', 'univ', 'college', 'institute', 'school', 'inc', 'ltd',
    'llc', 'gmbh', 'ag', 'se', 'plc', 'co', 'corp', 'corporation', 'company', 'technologies', 'technology', 'labs', 'group',
    'pvt', 'private', 'limited', 'global', 'international']);

  function norm(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function orgTokens(s) {
    return norm(s).split(' ').filter(w => w && !ORG_NOISE.has(w));
  }

  // Initials of the significant words: "Indian Institute of Technology Bombay" → "iitb".
  function initials(s) {
    return norm(s).split(' ').filter(w => w && !['of', 'and', 'the', 'at', 'for'].includes(w)).map(w => w[0]).join('');
  }

  function sameOrg(a, b) {
    if (!a || !b) return false;
    const na = norm(a), nb = norm(b);
    if (na === nb) return true;
    const A = orgTokens(a), B = orgTokens(b);
    if (A.length && B.length) {
      const setB = new Set(B);
      const inter = A.filter(w => setB.has(w)).length;
      if (inter && inter / Math.min(A.length, B.length) >= 0.99) return true;
    }
    // Acronym: "IIT Bombay" vs "Indian Institute of Technology Bombay", "TUM" vs "Technical University of Munich".
    const tryAcr = (short, long) => {
      const words = String(short).split(/[\s,]+/).filter(Boolean);
      const acr = words.find(w => /^[A-Z]{2,6}$/.test(w));
      if (!acr) return false;
      const rest = words.filter(w => w !== acr).map(norm).filter(w => w && !ORG_NOISE.has(w));
      const ini = initials(long);
      const nl = norm(long);
      return ini.startsWith(acr.toLowerCase()) && rest.every(w => nl.includes(w));
    };
    return tryAcr(a, b) || tryAcr(b, a);
  }

  function schools(p) {
    return (p?.educationEntries || []).map(e => String(e).split(' — ')[0].trim()).filter(Boolean);
  }

  function companies(p) {
    return [...new Set([p?.currentCompany, ...(p?.experienceEntries || []).map(e => e.company), ...(p?.pastCompanies || [])]
      .filter(Boolean).map(c => String(c).split('·')[0].trim()))];
  }

  function city(p) {
    return String(p?.location || '').split(',')[0].replace(/\b(area|metropolitan|greater|region)\b/gi, '').trim();
  }

  /**
   * @returns {Array<{id:string,type:string,text:string,detail?:string,weight:number}>}
   */
  function find(me, them) {
    if (!me || !them) return [];
    if (me.profileUrl && them.profileUrl && me.profileUrl === them.profileUrl) return [];
    const out = [];
    const first = String(them.name || 'They').split(' ')[0];

    if (me.currentCompany && them.currentCompany && sameOrg(me.currentCompany, them.currentCompany)) {
      out.push({ id: 'co-now', type: 'company', weight: 6, text: `You both work at ${them.currentCompany}` });
    }

    for (const s of schools(them)) {
      const mine = schools(me).find(x => sameOrg(x, s));
      if (mine) out.push({ id: 'edu:' + norm(s), type: 'school', weight: 5, text: `You both studied at ${s}` });
    }

    const myCos = companies(me);
    for (const c of companies(them)) {
      if (out.some(o => o.id === 'co-now') && sameOrg(c, them.currentCompany)) continue;
      const mine = myCos.find(x => sameOrg(x, c));
      if (!mine) continue;
      const theirsNow = sameOrg(c, them.currentCompany);
      const mineNow = sameOrg(mine, me.currentCompany);
      const text = theirsNow ? `${first} works at ${c}, where you've worked`
        : mineNow ? `${first} used to work at ${c}, where you work now`
        : `You've both worked at ${c}`;
      out.push({ id: 'co:' + norm(c), type: 'company', weight: 4, text });
    }

    const myCity = city(me), theirCity = city(them);
    if (myCity && theirCity && norm(myCity) === norm(theirCity)) {
      out.push({ id: 'city', type: 'location', weight: 2, text: `You're both based in ${theirCity}` });
    }

    const mySkills = new Map((me.skills || []).map(s => [norm(s), s]));
    const shared = (them.skills || []).filter(s => mySkills.has(norm(s)));
    if (shared.length) {
      const list = shared.slice(0, 3);
      const text = list.length === 1 ? `You both list ${list[0]} as a skill`
        : `You both list ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
      out.push({ id: 'skills', type: 'skill', weight: Math.min(3, shared.length), text, detail: shared.length > 3 ? `+${shared.length - 3} more shared skills` : undefined });
    }

    return out.sort((a, b) => b.weight - a.weight);
  }

  return { find, sameOrg, norm };
})();

if (typeof module !== 'undefined') module.exports = CommonGround;
