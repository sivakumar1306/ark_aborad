'use strict';
// Unit tests for the local "trust layer": fact check, common ground, writing lint.
//   node tests/unit.js

const path = require('path');
const ext = (f) => path.join(__dirname, '..', 'linkedin extention', 'utils', f);
const Grounding = require(ext('grounding.js'));
const CommonGround = require(ext('common.js'));
const Lint = require(ext('lint.js'));
global.Formats = require(ext('formats.js'));
const LocalWriter = require(ext('localwriter.js'));
global.Claude = require(ext('api.js'));
const Prompts = require(ext('prompts.js'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
}

const priya = {
  name: 'Priya Sharma', headline: 'Senior ML Engineer at Lumen Analytics | Feature stores · MLOps',
  currentTitle: 'Senior ML Engineer', currentCompany: 'Lumen Analytics', location: 'Berlin, Germany',
  about: 'I build the plumbing that turns messy data into reliable ML features. Previously shipped recommendation systems at Zalando.',
  recentPosts: ["We're hiring two junior ML engineers in Berlin!", 'Slides from my PyData Berlin talk on building feature stores are up.'],
  experienceEntries: [{ title: 'Senior ML Engineer', company: 'Lumen Analytics' }, { title: 'Data Scientist', company: 'Zalando', description: 'Built the size-recommendation model used across 23 markets, cutting returns by 4%.' }],
  pastCompanies: ['Zalando'], educationEntries: ['TU Munich — MSc, Informatics', 'IIT Bombay — BTech, Computer Science'],
  skills: ['Machine Learning', 'Python', 'Apache Spark'], profileUrl: 'https://www.linkedin.com/in/priya/'
};
const me = {
  name: 'Sam Rivera', currentCompany: 'TU Delft', location: 'Berlin, Germany',
  experienceEntries: [{ title: 'ML Intern', company: 'Zalando' }],
  educationEntries: ['TU Delft — MSc, Computer Science', 'Indian Institute of Technology Bombay — BTech, Computer Science'],
  skills: ['Python', 'Machine Learning', 'SQL'], profileUrl: 'https://www.linkedin.com/in/sam/'
};
const ctx = { profile: priya, hooks: ['Lumen Analytics just raised a Series B to expand in Europe'], userBio: 'Final-year CS student at TU Delft. Built a feature store for my thesis.', userName: 'Sam Rivera' };
const status = (r, needle) => r.sentences.find(s => s.text.includes(needle))?.status;

console.log('\nFact check');
{
  const r = Grounding.check("Hi Priya, loved your PyData Berlin talk on feature stores. Congrats on the Series B at Lumen! I'm a CS student at TU Delft building something similar. Would you be open to a 15 minute chat?\n\nBest,\nSam Rivera", ctx);
  check('true claim from a post is backed', status(r, 'PyData') === 'backed');
  check('funding claim backed by research hook', status(r, 'Series B') === 'backed');
  check('claim about sender backed by their bio', status(r, 'TU Delft') === 'backed');
  check('the ask is neutral, not a claim', status(r, '15 minute') === 'neutral');
  check('greeting and sign-off are neutral', r.sentences.filter(s => s.status === 'neutral').length >= 3);
  check('no false alarms on a fully true message', r.unverified === 0, r.sentences.filter(s => s.status === 'unverified'));
  const src = r.sentences.find(s => s.text.includes('PyData')).claims[0].source;
  check('evidence points at the right source', src.label === 'Their recent post' && src.snippet.includes('PyData Berlin'), src);
}
{
  const r = Grounding.check('Hi Priya, congrats on your recent promotion to Director at Google! Your work cutting returns by 7% at Zalando was inspiring. I spoke at NeurIPS last year.', ctx);
  const promo = r.sentences.find(s => s.text.includes('promotion'));
  check('invented promotion flagged', promo.status === 'unverified');
  check('names the missing terms', ['Director', 'Google', 'promotion'].every(t => promo.missing.some(m => m.value.includes(t))), promo.missing);
  check('wrong number flagged even with a real company', status(r, '7%') === 'unverified');
  check('sender claim checked only against sender data', status(r, 'NeurIPS') === 'unverified');
  check('counts', r.unverified === 3 && r.backed === 0, [r.backed, r.unverified]);
}
{
  const r = Grounding.check('Subject: Your size model at Zalando\n\nHi Priya,\n\nThe 23-market rollout of your size-recommendation model is impressive. Saw you\'re hiring junior ML engineers in Berlin. Open to a quick chat?', ctx);
  check('subject line checked', status(r, 'Subject') === 'backed');
  check('number backed by experience description', status(r, '23-market') === 'backed');
  check('capitalised first word is not a claim', status(r, 'Open to') === 'neutral');
  check('offsets map back to the text', r.sentences.every(s => 'Subject: Your size model at Zalando\n\nHi Priya,\n\nThe 23-market rollout of your size-recommendation model is impressive. Saw you\'re hiring junior ML engineers in Berlin. Open to a quick chat?'.slice(s.start, s.end) === s.text));
}
{
  const common = CommonGround.find(me, priya);
  const r = Grounding.check('Hi Priya, fellow IIT Bombay alum here! Would you be open to connecting?', { ...ctx, common });
  check('shared-background claim backed', status(r, 'IIT Bombay') === 'backed');
}

{
  const r = Grounding.check("I'm Sam Rivera and I'd love 15 minutes to hear how your team approaches its roadmap.", ctx);
  check('no false alarm on "I’m <name> and I’d…"', r.unverified === 0, r.sentences.map(x => x.missing));
}

console.log('\nCommon ground');
{
  const c = CommonGround.find(me, priya);
  const texts = c.map(x => x.text);
  check('school via acronym (IIT Bombay ↔ Indian Institute of Technology Bombay)', texts.includes('You both studied at IIT Bombay'), texts);
  check('shared past company', texts.some(t => /both worked at Zalando/.test(t)), texts);
  check('same city', texts.includes("You're both based in Berlin"), texts);
  check('shared skills', texts.some(t => /Machine Learning and Python|Python and Machine Learning/.test(t)), texts);
  check('ranked: school before skills', c.findIndex(x => x.type === 'school') < c.findIndex(x => x.type === 'skill'));
  check('nothing for your own profile', CommonGround.find(me, { ...me }).length === 0);
  check('TUM acronym', CommonGround.sameOrg('TUM', 'Technical University of Munich'));
  check('legal suffixes ignored', CommonGround.sameOrg('Zalando SE', 'Zalando'));
  check('different orgs differ', !CommonGround.sameOrg('Google', 'Microsoft') && !CommonGround.sameOrg('TU Delft', 'TU Munich'));
}

console.log('\nWriting lint');
{
  const ids = (t, c = {}) => Lint.check(t, { format: 'note', recipientName: 'Priya Sharma', ...c }).map(i => i.id);
  check('placeholder', ids('Hi [Name], would you like to chat?').includes('placeholder'));
  check('wrong name in greeting', ids('Hi Priyanka, would you like to chat?').includes('wrong-name'));
  check('right name passes', !ids('Hi Priya, would you like to chat?').includes('wrong-name'));
  check('cliché', ids('Hi Priya, I came across your profile. Open to chat?').some(i => i.startsWith('cliche:')));
  check('no ask', ids('Hi Priya, great work on feature stores.').includes('no-ask'));
  check('ask present', !ids('Hi Priya, open to a quick chat sometime').includes('no-ask'));
  check('me-me-me', ids('Hi Priya. I am a student. I build tools. I like ML. My thesis is cool. Chat?').includes('me-me-me'));
  check('missing subject for InMail', ids('Hi Priya, chat?', { format: 'inmail' }).includes('no-subject'));
  check('generic when no specifics', ids('Hi Priya, chat?', { grounding: { specificsAboutThem: 0, unverified: 0 } }).includes('generic'));
  check('clean message has no warnings', Lint.check('Hi Priya, loved your PyData talk on feature stores. Open to a quick chat?', { format: 'note', recipientName: 'Priya Sharma', grounding: { specificsAboutThem: 2, unverified: 0 } }).length === 0);
}

console.log('\nFree-mode writer');
{
  const sender = { name: 'Sam Rivera', bio: 'Final-year CS student into ML infra.' };
  const common = CommonGround.find(me, priya).map(c => c.text);
  let worst = 0, cliche = 0, unverified = 0, wrongLen = 0;
  const seen = new Set();
  for (const purpose of ['Networking', 'Job', 'Referral', 'Collaboration']) {
    for (const tone of ['Formal', 'Neutral', 'Casual']) {
      for (const format of ['note', 'dm', 'inmail', 'email']) {
        for (const variant of [0, 1, 2, 3]) {
          for (const cg of [[], common]) {
            const t = LocalWriter.write({ profile: priya, sender, common: cg, hooks: [], purpose, tone, format, noteLimit: 200, variant });
            seen.add(t);
            if (format === 'note') worst = Math.max(worst, t.length);
            const f = Formats.get(format, { noteLimit: 200 });
            if (f.limit && Formats.measure(t, format, { noteLimit: 200 }).n > f.limit) wrongLen++;
            if (Lint.check(t, { format, recipientName: priya.name }).some(i => i.id.startsWith('cliche') || i.id === 'placeholder' || i.id === 'wrong-name' || i.id === 'no-subject')) cliche++;
            unverified += Grounding.check(t, { profile: priya, common: cg.map(text => ({ text })), userBio: sender.bio, userName: sender.name }).unverified;
          }
        }
      }
    }
  }
  check('every note fits 200 chars (384 combos)', worst <= 200, worst);
  check('every format within its hard limit', wrongLen === 0, wrongLen);
  check('no clichés, placeholders, wrong names or missing subjects', cliche === 0, cliche);
  check('zero unverified claims across all combos', unverified === 0, unverified);
  check('variants actually differ', seen.size > 40, seen.size);
  const hooks = LocalWriter.hooks(priya);
  check('profile hooks for free Deep mode', hooks.length >= 4 && hooks[0].kind === 'post', hooks.map(h => h.kind));
  const bare = LocalWriter.write({ profile: { name: 'Jo Lee' }, sender: {}, purpose: 'Networking', tone: 'Neutral', format: 'note' });
  check('sparse profile still yields a clean note', /^Hi Jo,/.test(bare) && bare.length < 200, bare);
}

console.log('\nClaude client');
(async () => {
  const realFetch = global.fetch;
  const respond = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => JSON.stringify(body) });
  const errBody = (type, message) => ({ type: 'error', error: { type, message } });
  const run = async (responses, opts = {}) => {
    const calls = [];
    global.fetch = async (url, init) => { calls.push(init); const r = responses[Math.min(calls.length - 1, responses.length - 1)]; return typeof r === 'function' ? r() : r; };
    try { return { data: await Claude.create('sk-ant-x', { model: 'claude-haiku-5-5' }, { retries: 2, ...opts }), calls }; }
    catch (e) { return { error: e, calls }; }
  };
  const ok = respond(200, { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hello' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 } });

  let r = await run([ok]);
  const h = r.calls[0].headers;
  check('sends key, version and direct-browser header', h['x-api-key'] === 'sk-ant-x' && h['anthropic-version'] === '2023-06-01' && h['anthropic-dangerous-direct-browser-access'] === 'true');
  check('reads only text blocks', Claude.textOf(r.data) === 'Hello');
  check('cost from usage (Haiku 5.5)', Math.abs(Claude.cost('claude-haiku-5-5', r.data.usage) - 0.00015) < 1e-9, Claude.cost('claude-haiku-5-5', r.data.usage));
  r = await run([respond(401, errBody('authentication_error', 'invalid x-api-key'))]);
  check('401 → auth, not retried', r.error.code === 'auth' && r.calls.length === 1);
  r = await run([respond(400, errBody('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'))]);
  check('low credit → billing', r.error.code === 'billing');
  r = await run([respond(529, errBody('overloaded_error', 'Overloaded'), { 'retry-after': '0' }), ok]);
  check('529 retried, then succeeds', !r.error && r.calls.length === 2);
  r = await run([respond(429, errBody('rate_limit_error', 'rate limited'), { 'retry-after': '0' }), ok]);
  check('429 retried', !r.error && r.calls.length === 2);
  r = await run([{ ok: true, status: 200, headers: { get: () => null }, text: async () => '<html>' }, ok]);
  check('non-JSON 200 retried', !r.error && r.calls.length === 2);
  let threw = null;
  try { Claude.textOf({ stop_reason: 'refusal', content: [] }); } catch (e) { threw = e; }
  check('refusal surfaced as a clear error', threw?.code === 'refusal');
  threw = null;
  try { Claude.textOf({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] }); } catch (e) { threw = e; }
  check('truncated (thinking only) surfaced', threw?.code === 'truncated');
  check('no key → clear error', (await Claude.create('', {}).catch(e => e)).code === 'no_key');

  console.log('\nResearch parsing');
  const searchResults = { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://www.techcrunch.com/a/', title: 'A' }] };
  const final = { stop_reason: 'end_turn', usage: { input_tokens: 5000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
    content: [{ type: 'server_tool_use', name: 'web_search' }, searchResults, { type: 'text', text: '<hooks>[{"hook":"Real one","url":"https://techcrunch.com/a","date":"2026-10"},{"hook":"Made up","url":"https://nowhere.example/x"},{"hook":"No url"}]</hooks>' }] };
  r = await (async () => { global.fetch = async () => respond(200, final); return Prompts.research('sk-ant-x', priya); })();
  check('keeps hooks whose URL was in the search results', r.hooks.length === 1 && r.hooks[0].text === 'Real one' && r.hooks[0].url === 'https://www.techcrunch.com/a/', r.hooks);
  check('counts searches and cost', r.searches === 1 && r.cost > 0.01, r);
  const body = Prompts.researchBody(priya);
  check('research request: web_search_20260209 on Sonnet 5.5 with fallback', body.model === 'claude-sonnet-5-5' && body.tools[0].type === 'web_search_20260209' && body.fallbacks === 'default');
  const wb = Prompts.writerBody({ model: 'claude-haiku-5-5', profile: priya, hooks: [], common: [], sender: {}, purpose: 'Job', tone: 'Neutral', requirements: 'X', resumeBase64: 'AAAA' });
  check('writer request: resume as a PDF document block, no fallbacks on Haiku', wb.messages[0].content[0].type === 'document' && !('fallbacks' in wb));

  global.fetch = realFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
