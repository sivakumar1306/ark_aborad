'use strict';
// Mock of the Anthropic Messages API (POST /v1/messages), for testing AI mode
// without a real key or spending money. Mirrors the response shapes the
// extension relies on: thinking + text blocks, usage, web search server-tool
// blocks, pause_turn, and typed error bodies.
//
// Behaviour switches, read from the request (as the extension sends them):
//   "HALLUCINATE" in the extra context  → writes an invented promotion
//   "LONG" in the extra context         → an over-limit connection note
//   "FLAKY" in the extra context        → first call returns 529 overloaded
//   "NOCREDIT" in the extra context     → 400 credit balance too low

const http = require('http');

const VALID_KEY = 'sk-ant-test-valid-key-0123456789abcdef';
const GEMINI_KEY = 'AIzaTEST-valid-key-0123456789abcdefghijk';
const log = [];
let flaked = false;
let searchLimited = false; // POST /__search_limit toggles Gemini search rate-limiting

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function userText(body) {
  const c = body.messages?.[0]?.content;
  if (typeof c === 'string') return c;
  return (c || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function parseContext(text) {
  const m = /<context>\s*([\s\S]*?)\s*<\/context>/.exec(text);
  try { return m ? JSON.parse(m[1]) : {}; } catch (_) { return {}; }
}

function requirements(text) {
  const m = /<requirements>\s*([\s\S]*?)\s*<\/requirements>/.exec(text);
  return m ? m[1] : '';
}

function formatOf(req) {
  if (/connection request note/i.test(req)) return 'note';
  if (/direct message/i.test(req)) return 'dm';
  if (/InMail/.test(req)) return 'inmail';
  if (/cold email/i.test(req)) return 'email';
  return 'note';
}

function writeMessage(ctx, req) {
  const p = ctx.recipient || {};
  const first = (p.name || 'there').split(' ')[0];
  const role = p.currentTitle ? ` your work as ${p.currentTitle}` : ' your work';
  const company = p.currentCompany ? ` at ${p.currentCompany}` : '';
  const hook = ctx.research_hooks?.[0]?.hook;
  const hookLine = hook ? ` Saw that ${hook.charAt(0).toLowerCase() + hook.slice(1).replace(/\.$/, '')}.` : '';
  const sender = ctx.sender?.name || 'a student';
  const revising = /Revise the previous draft/.test(req);
  const shorter = /shorter/i.test(req);
  const common = /Open with the strongest one, naturally: ([^;\n]+?)(?:;|\.\n|\.$)/.exec(req);
  const school = common && /studied at (.+)$/.exec(common[1]);
  const format = formatOf(req);

  if (/HALLUCINATE/.test(req) && !revising) {
    return `Hi ${first}, congrats on your recent promotion to Director at Google! I came across your profile and loved${role}${company}. Would you be open to a quick chat?`;
  }
  if (revising) {
    return `Hi ${first}, loved${role}${company}.${hookLine.slice(0, 80)} Would you be open to a quick chat about how your team works?`.slice(0, 199);
  }
  if (format === 'inmail' || format === 'email') {
    return `Subject: Quick question about ${p.currentCompany || 'your team'}\n\nHi ${first},\n\nI've been following${role}${company}.${hookLine} I'm ${sender} and I'd love 15 minutes to hear how your team approaches its roadmap.\n\nWould next week work?\n\nBest,\n${sender}`;
  }
  if (format === 'dm') {
    return `Hi ${first}, thanks for connecting!${hookLine} I really enjoyed reading about${role}${company}. I'm exploring this space and would value your perspective. Open to a quick chat sometime?`;
  }
  if (school) return `Hi ${first}, fellow ${school[1]} alum here! Loved${role}${company}. Would you be open to connecting?`;
  if (/LONG/.test(req) && !shorter) {
    return `Hi ${first}, I was genuinely impressed by${role}${company}.${hookLine} I'm ${sender}, working on similar problems, and I would really love to connect, learn from your experience, and swap notes on what has worked for your team recently. Thanks so much!`;
  }
  return `Hi ${first}, loved${role}${company}.${hookLine ? hookLine.slice(0, 70) : ''} I'm ${sender} and would love to connect!`.slice(0, 199);
}

function message(model, content, usage, stop = 'end_turn') {
  return { id: 'msg_mock_' + Date.now(), type: 'message', role: 'assistant', model, content, stop_reason: stop, usage };
}

function research(body) {
  const who = JSON.parse(/<person>\s*([\s\S]*?)\s*<\/person>/.exec(userText(body))?.[1] || '{}');
  const co = who.currentCompany || 'Their company';
  const search = {
    type: 'server_tool_use', id: 'srvtoolu_01', name: 'web_search', input: { query: `${co} news 2026` }
  };
  const results = {
    type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01',
    content: [
      { type: 'web_search_result', url: 'https://techcrunch.com/2026/10/14/lumen-analytics-series-b/', title: `${co} raises $40M Series B`, page_age: 'October 14, 2026', encrypted_content: 'x' },
      { type: 'web_search_result', url: 'https://pydata.org/berlin2026/speaker/priya-sharma', title: 'PyData Berlin 2026: Feature stores without a platform team', page_age: 'September 2026', encrypted_content: 'x' }
    ]
  };
  // First call pauses mid-turn, like a long server-tool loop does.
  if (body.messages.length === 1) {
    return message(body.model, [search, results], { input_tokens: 4200, output_tokens: 120, server_tool_use: { web_search_requests: 1 } }, 'pause_turn');
  }
  const hooks = [
    { hook: `${co} raised a $40M Series B in October 2026 to expand in Europe`, url: 'https://techcrunch.com/2026/10/14/lumen-analytics-series-b', date: '2026-10' },
    { hook: `${who.name} spoke at PyData Berlin 2026 about feature stores`, url: 'https://pydata.org/berlin2026/speaker/priya-sharma/', date: '2026-09' },
    { hook: `${who.name} was named to Forbes 30 Under 30`, url: 'https://made-up.example.com/forbes', date: '' }
  ];
  return message(body.model, [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: `I found two reliable items.\n<hooks>${JSON.stringify(hooks)}</hooks>` }
  ], { input_tokens: 9800, output_tokens: 650, server_tool_use: { web_search_requests: 1 } });
}

const server = http.createServer(async (req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  const err = (status, type, msg) => send(status, { type: 'error', error: { type, message: msg }, request_id: 'req_mock' });

  if (req.method === 'GET' && req.url === '/__log') return send(200, log);
  if (req.method === 'POST' && req.url === '/__search_limit') { searchLimited = !searchLimited; return send(200, { searchLimited }); }
  if (req.method === 'POST' && req.url === '/__reset') { log.length = 0; flaked = false; return send(200, { ok: true }); }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch (_) { return err(400, 'invalid_request_error', 'bad json'); }
  const headers = {
    key: req.headers['x-api-key'], version: req.headers['anthropic-version'],
    browser: req.headers['anthropic-dangerous-direct-browser-access'], beta: req.headers['anthropic-beta']
  };
  const entry = { path: req.url, body, headers, at: Date.now() };
  log.push(entry);

  if (req.url.startsWith('/v1beta/')) return gemini(req, body, send);
  if (req.url !== '/v1/messages') return err(404, 'not_found_error', 'Not found');
  if (headers.key !== VALID_KEY) return err(401, 'authentication_error', 'invalid x-api-key');
  if (!headers.version) return err(400, 'invalid_request_error', 'anthropic-version header is required');

  const text = userText(body);
  if (/Reply with the single word: OK/.test(text)) {
    return send(200, message(body.model, [{ type: 'text', text: 'OK' }], { input_tokens: 12, output_tokens: 2 }));
  }
  if ((body.tools || []).some(t => t.name === 'web_search')) {
    await sleep(700);
    return send(200, research(body));
  }

  const ctx = parseContext(text);
  const reqs = requirements(text);
  if (/NOCREDIT/.test(reqs)) return err(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.');
  if (/FLAKY/.test(reqs) && !flaked) { flaked = true; entry.flaked = true; return err(529, 'overloaded_error', 'Overloaded'); }

  await sleep(350);
  return send(200, message(body.model, [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: writeMessage(ctx, reqs) }
  ], { input_tokens: 1400, output_tokens: 180 }));
});

// ─── Gemini (generativelanguage.googleapis.com/v1beta) ─────────────────────────
async function gemini(req, body, send) {
  const gerr = (code, status, message) => send(code, { error: { code, status, message } });
  if (req.headers['x-goog-api-key'] !== GEMINI_KEY) return gerr(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.');
  if (req.method === 'GET' && req.url.startsWith('/v1beta/models')) {
    const m = (name, methods = ['generateContent', 'countTokens']) => ({ name: `models/${name}`, supportedGenerationMethods: methods });
    return send(200, { models: [m('gemini-3.8-flash'), m('gemini-2.0-flash'), m('gemini-2.5-flash'), m('gemini-2.5-flash-lite'), m('gemini-2.5-pro'),
      m('gemini-2.5-flash-preview-tts'), m('text-embedding-004', ['embedContent'])] });
  }
  const model = (/models\/([^:]+):generateContent/.exec(req.url) || [])[1];
  if (!model) return gerr(404, 'NOT_FOUND', 'Not found');
  // The newest model is "overloaded", like a fresh model on the free tier often is.
  if (model === 'gemini-3.8-flash') return gerr(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.');
  const text = (body.contents?.[0]?.parts || []).map(p => p.text || '').join('\n');
  const answer = (t, extra = {}) => send(200, {
    candidates: [{ content: { role: 'model', parts: [{ text: 'Let me think…', thought: true }, { text: t }] }, finishReason: 'STOP', ...extra }],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 150 }
  });
  if (/single word: OK/.test(text)) return answer('OK');
  if ((body.tools || []).some(t => t.google_search) && searchLimited) {
    return gerr(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for grounding requests per minute.');
  }
  if ((body.tools || []).some(t => t.google_search)) {
    await sleep(500);
    const who = JSON.parse(/<person>\s*([\s\S]*?)\s*<\/person>/.exec(text)?.[1] || '{}');
    const co = who.currentCompany || 'Their company';
    const hooks = [
      { hook: `${co} raised a $40M Series B in October 2026 to expand in Europe`, url: 'https://techcrunch.com/2026/10/14/lumen-analytics-series-b/', date: '2026-10' },
      { hook: `${who.name} spoke at PyData Berlin 2026 about feature stores`, url: 'https://pydata.org/berlin2026/speaker/priya-sharma/', date: '2026-09' },
      { hook: `${who.name} was named to Forbes 30 Under 30`, url: 'https://made-up.example.com/forbes', date: '' }
    ];
    return answer(`Found two.\n<hooks>${JSON.stringify(hooks)}</hooks>`, {
      groundingMetadata: {
        webSearchQueries: [`${co} news 2026`],
        groundingChunks: [
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA', title: 'techcrunch.com' } },
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB', title: 'pydata.org' } }
        ]
      }
    });
  }
  await sleep(300);
  return answer(writeMessage(parseContext(text), requirements(text)));
}

const port = Number(process.env.PORT || 8787);
server.listen(port, () => console.log(`mock Anthropic API on :${port}`));
module.exports = server;
module.exports.VALID_KEY = VALID_KEY;
