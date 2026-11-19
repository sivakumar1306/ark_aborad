'use strict';
// Mock of the Ark server API, for local testing without spending real credits.
// Mirrors the request/response shapes background.js relies on.

const http = require('http');

const VALID_KEY = 'ARK-TEST-0000-0001';
let remaining = 20;
const log = [];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function messageFor(body, kind) {
  const p = body.profileData || body.profileJSON || {};
  const first = (p.name || 'there').split(' ')[0];
  const hooks = (body.enrichmentJSON && body.enrichmentJSON.topHooks) || [];
  const hook = hooks[0] ? ` Saw that ${hooks[0].charAt(0).toLowerCase() + hooks[0].slice(1).replace(/\.$/, '')}, exciting stuff.` : '';
  const role = p.currentTitle ? ` your work as ${p.currentTitle}` : ' your work';
  const company = p.currentCompany ? ` at ${p.currentCompany}` : '';
  const shorter = /shorter/i.test(body.instructions || '');
  const long = /LONG/.test(body.userBio || '');
  const revising = /Revise the previous draft/.test(body.instructions || '');
  const common = /Open with the strongest one, naturally: ([^;\n]+?)(?:;|\.\n|\.$)/.exec(body.instructions || '');
  const school = common && /studied at (.+)$/.exec(common[1]);

  // Simulate a model hallucination the fact check should catch.
  if (/HALLUCINATE/.test(body.userBio || '') && !revising) {
    return `Hi ${first}, congrats on your recent promotion to Director at Google! I came across your profile and loved${role}${company}. Would you be open to a quick chat?`;
  }
  if (revising) {
    return `Hi ${first}, loved${role}${company}.${hook ? hook.slice(0, 70) : ''} Would you be open to a quick chat about how your team works?`.slice(0, 199);
  }
  if (school && body.format === 'note') {
    return `Hi ${first}, fellow ${school[1]} alum here! Loved${role}${company}. Would you be open to connecting?`;
  }

  switch (body.format) {
    case 'inmail':
    case 'email':
      return `Subject: Quick question about ${p.currentCompany || 'your team'}\n\nHi ${first},\n\nI've been following${role}${company}.${hook} I'm ${body.userName || 'a student'} and I'd love 15 minutes to hear how your team approaches ${body.messageType === 'Job' ? 'hiring for new grads' : 'its roadmap'}.\n\nWould next week work?\n\nBest,\n${body.userName || ''}`;
    case 'dm':
      return `Hi ${first}, thanks for connecting!${hook} I really enjoyed reading about${role}${company}. I'm exploring ${body.messageType === 'Job' ? 'roles' : 'ideas'} in this space and would value your perspective. Open to a quick chat sometime?`;
    default: {
      if (long && !shorter) {
        return `Hi ${first}, I came across your profile and was genuinely impressed by${role}${company}.${hook} I'm ${body.userName || 'a student'} working on similar problems and I would really love to connect, learn from your experience, and perhaps swap notes on what's worked for your team recently. Thanks so much!`;
      }
      return `Hi ${first}, loved${role}${company}.${hook ? hook.slice(0, 70) : ''} I'm ${body.userName || 'exploring this space'} too and would love to connect!`.slice(0, 199);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const send = (status, obj, raw) => {
    res.writeHead(status, { 'Content-Type': raw ? 'text/html' : 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(raw || JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/__log') return send(200, log);
  if (req.method === 'POST' && req.url === '/__reset') { log.length = 0; remaining = 20; return send(200, { ok: true }); }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch (_) { return send(400, { error: 'bad json' }); }
  log.push({ path: req.url, body, at: Date.now() });

  if (req.url === '/api/validate') {
    return body.key === VALID_KEY
      ? send(200, { valid: true, remaining })
      : send(200, { valid: false, reason: 'Key not recognised.' });
  }

  if (body.key !== VALID_KEY) return send(401, { success: false, error: 'Invalid license key.' });

  // Simulated cold start: first call with "FLAKY" context returns a Railway HTML 502.
  if (/FLAKY/.test(body.userBio || '') && !log.some(l => l.flaked)) {
    log[log.length - 1].flaked = true;
    return send(502, null, '<html><body><h1>502 Bad Gateway</h1></body></html>');
  }

  if (req.url === '/api/generate/quick') {
    await sleep(400);
    remaining--;
    return send(200, { success: true, message: messageFor(body, 'quick'), remaining });
  }
  if (req.url === '/api/generate/enrich') {
    await sleep(900);
    const p = body.rawProfileData || {};
    return send(200, {
      success: true,
      profileJSON: { name: p.name, headline: p.headline, currentTitle: p.currentTitle, currentCompany: p.currentCompany },
      enrichmentJSON: {
        topHooks: [
          `${p.currentCompany || 'Their company'} just raised a Series B to expand in Europe`,
          `Spoke at PyData Berlin about feature stores`,
          `Recently posted about hiring junior ML engineers`,
          `Open-sourced an internal data-quality tool`
        ],
        companyNews: []
      }
    });
  }
  if (req.url === '/api/generate/deep') {
    await sleep(600);
    remaining--;
    return send(200, { success: true, message: messageFor(body, 'deep'), remaining });
  }
  send(404, { error: 'not found' });
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => console.log(`mock server on :${port}`));
module.exports = server;
