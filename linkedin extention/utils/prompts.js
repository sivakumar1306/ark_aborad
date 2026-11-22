'use strict';

// utils/prompts.js — what we ask Claude, and how we read the answer.
//
// Writer: the full context goes in as JSON inside <context> tags, the per-request
// requirements (format, hard limit, revision instructions) in <requirements>.
// Research: Claude Sonnet 5.5 with the web search server tool, asked to return hooks
// with the URL each came from. URLs are kept only if they appeared in the actual
// search results, so a made-up link never reaches the user.

const Prompts = (() => {
  const WRITER_SYSTEM = [
    'You write LinkedIn outreach messages on behalf of the sender. Write the way a thoughtful person would: specific, warm, brief, and easy to say yes to.',
    '',
    'Facts: use only what is in <context>: the recipient’s profile, research hooks, shared background and the sender’s details. If something isn’t there, leave it out. Never invent promotions, funding, talks, numbers, job titles or mutual connections.',
    'Opening: lead with something specific to the recipient. Shared background is the strongest opener when provided; otherwise use a research hook or something from their profile.',
    'Ask: end with one clear, low-pressure ask.',
    'Style: no placeholders and no stock phrases such as "I came across your profile", "I hope this finds you well" or "pick your brain". Write in the sender’s voice, in first person.',
    'Length and format: the requirements are hard limits set by LinkedIn. Follow them exactly.',
    'Output only the message itself, starting with a "Subject:" line when the format needs one. No preamble, quotes or commentary.'
  ].join('\n');

  const RESEARCH_SYSTEM = [
    'You research a person and their current company to find genuine, recent conversation starters for a LinkedIn message.',
    'Use web search. Prefer the last 12 months: company news (funding, launches, hiring, expansion), and talks, articles, podcasts or open-source work by this person.',
    'Only include items you actually found in search results, each with the URL it came from. Skip anything you are not sure refers to this exact person or company.',
    'End your reply with up to 5 hooks in exactly this format:',
    '<hooks>[{"hook": "one factual, specific sentence", "url": "https://…", "date": "YYYY-MM or empty"}]</hooks>',
    'If you find nothing reliable, reply <hooks>[]</hooks>.'
  ].join('\n');

  function compactProfile(p = {}) {
    const out = {
      name: p.name, headline: p.headline, currentTitle: p.currentTitle, currentCompany: p.currentCompany,
      currentRoles: (p.currentRoles || []).length > 1 ? p.currentRoles.map(r => [r.title, r.company].filter(Boolean).join(' at ')) : undefined,
      location: p.location, about: (p.about || '').slice(0, 1200),
      recentPosts: (p.recentPosts || []).slice(0, 3),
      experience: (p.experienceEntries || []).slice(0, 5).map(e => [e.title, e.company && `at ${e.company}`, e.duration].filter(Boolean).join(' ')),
      education: (p.educationEntries || []).slice(0, 3),
      skills: (p.skills || []).slice(0, 12)
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
  }

  /**
   * Build a writer request body.
   * ctx: { model, profile, hooks:[{text,url}], common:[string], sender:{name,bio,profile}, purpose, tone, requirements, resumeBase64 }
   */
  // The provider-neutral prompt: system text + user text (+ optional resume PDF).
  function writerPrompt(ctx) {
    const context = {
      recipient: compactProfile(ctx.profile),
      research_hooks: (ctx.hooks || []).map(h => (h.url ? { hook: h.text, source: h.url } : { hook: h.text })),
      shared_background: ctx.common || [],
      sender: {
        name: ctx.sender?.name || undefined,
        bio: ctx.sender?.bio || undefined,
        profile: ctx.sender?.profile ? compactProfile(ctx.sender.profile) : undefined
      },
      purpose: ctx.purpose === 'Advice' ? 'Career advice' : ctx.purpose,
      recipient_type: ctx.recipientType || undefined,
      address_them_as: typeof Names !== 'undefined' ? Names.greeting(ctx.profile?.name, ctx.tone) : undefined,
      tone: ctx.tone
    };
    return {
      system: WRITER_SYSTEM,
      text: `<context>\n${JSON.stringify(context, null, 1)}\n</context>\n\n<requirements>\n${ctx.requirements}\n</requirements>\n\nWrite the message now.`,
      pdfBase64: ctx.resumeBase64 || null
    };
  }

  function writerBody(ctx) {
    const prompt = writerPrompt(ctx);
    const content = [];
    if (ctx.resumeBase64) {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: ctx.resumeBase64 }, title: 'Sender’s resume' });
    }
    content.push({ type: 'text', text: prompt.text });

    const body = {
      model: ctx.model,
      max_tokens: 8000, // thinking is on by default on these models and counts toward this
      output_config: { effort: 'low' },
      system: WRITER_SYSTEM,
      messages: [{ role: 'user', content }]
    };
    if (ctx.model === 'claude-sonnet-5-5') body.fallbacks = 'default';
    return body;
  }

  function betasFor(model) {
    return model === 'claude-sonnet-5-5' ? ['server-side-fallback-2026-07-01'] : [];
  }

  // ─── Research ───────────────────────────────────────────────────────────────
  const RESEARCH_MODEL = 'claude-sonnet-5-5'; // web_search_20260209 needs Sonnet/Opus-class models

  function researchBody(profile) {
    const p = compactProfile(profile);
    const who = { name: p.name, headline: p.headline, currentTitle: p.currentTitle, currentCompany: p.currentCompany, location: p.location, experience: p.experience };
    return {
      model: RESEARCH_MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      system: RESEARCH_SYSTEM,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
      messages: [{ role: 'user', content: `Find conversation starters for this person:\n<person>\n${JSON.stringify(who, null, 1)}\n</person>` }]
    };
  }

  /**
   * Run research, resuming pause_turn up to 3 times.
   * @returns {{ hooks: Array<{text,url,title,date}>, searches: number, cost: number }}
   */
  async function research(apiKey, profile, { onRetry } = {}) {
    const body = researchBody(profile);
    let data = await Claude.create(apiKey, body, { timeoutMs: 120000, retries: 1, betas: betasFor(RESEARCH_MODEL), onRetry });
    let cost = Claude.cost(RESEARCH_MODEL, data.usage);
    const all = [...(data.content || [])];
    for (let i = 0; data.stop_reason === 'pause_turn' && i < 3; i++) {
      body.messages = [body.messages[0], { role: 'assistant', content: data.content }];
      data = await Claude.create(apiKey, body, { timeoutMs: 120000, retries: 1, betas: betasFor(RESEARCH_MODEL), onRetry });
      cost += Claude.cost(RESEARCH_MODEL, data.usage);
      all.push(...(data.content || []));
    }
    Claude.textOf(data); // throws on refusal

    // URLs that genuinely came back from search.
    const results = new Map();
    let searches = 0;
    for (const block of all) {
      if (block.type === 'server_tool_use' && block.name === 'web_search') searches++;
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.type === 'web_search_result' && r.url) results.set(normUrl(r.url), { url: r.url, title: r.title || '' });
      }
    }

    const text = all.filter(b => b.type === 'text').map(b => b.text || '').join('');
    const m = /<hooks>\s*([\s\S]*?)\s*<\/hooks>/i.exec(text);
    let parsed = [];
    if (m) { try { parsed = JSON.parse(m[1]); } catch (_) { parsed = []; } }
    const hooks = (Array.isArray(parsed) ? parsed : [])
      .map(h => {
        const found = h && h.url ? results.get(normUrl(h.url)) : null;
        return h && typeof h.hook === 'string' && h.hook.trim()
          ? { text: h.hook.trim(), url: found ? found.url : null, title: found ? found.title : null, date: h.date || null, kind: 'web' }
          : null;
      })
      .filter(h => h && h.url) // no verifiable source, no hook
      .slice(0, 5);
    return { hooks, searches, cost };
  }

  // ─── Research with Gemini + Google Search grounding ──────────────────────────
  // Gemini reports the pages it actually used (groundingChunks). A hook is kept only
  // if its source domain is one of those pages, same rule as the Claude path.
  async function researchGemini(apiKey, model, profile, { onRetry } = {}) {
    const p = compactProfile(profile);
    const who = { name: p.name, headline: p.headline, currentTitle: p.currentTitle, currentCompany: p.currentCompany, location: p.location, experience: p.experience };
    const data = await Gemini.generate(apiKey, {
      model, system: RESEARCH_SYSTEM, search: true, maxTokens: 8192,
      text: `Find conversation starters for this person:\n<person>\n${JSON.stringify(who, null, 1)}\n</person>`
    }, { timeoutMs: 120000, retries: 1, onRetry });
    const text = Gemini.textOf(data);
    const sources = Gemini.sourcesOf(data);
    const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; } };
    const grounded = sources.map(s => ({ ...s, domain: (s.title && /\./.test(s.title) ? s.title : hostOf(s.uri)).replace(/^www\./, '').toLowerCase() }));

    const m = /<hooks>\s*([\s\S]*?)\s*<\/hooks>/i.exec(text);
    let parsed = [];
    if (m) { try { parsed = JSON.parse(m[1]); } catch (_) { parsed = []; } }
    const hooks = (Array.isArray(parsed) ? parsed : [])
      .map(h => {
        if (!h || typeof h.hook !== 'string' || !h.hook.trim()) return null;
        const d = hostOf(h.url);
        const src = d && grounded.find(g => g.domain === d || g.domain.endsWith('.' + d) || d.endsWith('.' + g.domain));
        return src ? { text: h.hook.trim(), url: h.url, title: src.title || d, date: h.date || null, kind: 'web' } : null;
      })
      .filter(Boolean)
      .slice(0, 5);
    return { hooks, searches: Gemini.searchCount(data) || (sources.length ? 1 : 0), cost: 0 };
  }

  function normUrl(u) {
    try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase(); }
    catch (_) { return String(u).toLowerCase(); }
  }

  return { writerPrompt, writerBody, researchBody, research, researchGemini, betasFor, RESEARCH_MODEL, WRITER_SYSTEM };
})();

if (typeof module !== 'undefined') module.exports = Prompts;
