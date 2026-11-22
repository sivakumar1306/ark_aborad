'use strict';
// End-to-end test: loads the real extension in Chromium against LinkedIn-like
// fixture pages and a mock of the Ark server.
//   node tests/e2e.js            run checks
//   SHOTS=1 node tests/e2e.js    also save screenshots to docs/screenshots/

const { chromium } = require('playwright');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const EXT_SRC  = path.join(ROOT, 'linkedin extention');
const PORT     = 8787;
const MOCK     = `http://localhost:${PORT}`;
const KEY      = 'sk-ant-test-valid-key-0123456789abcdef'; // the mock's valid key
const SHOTS    = process.env.SHOTS ? path.join(ROOT, 'docs', 'screenshots') : null;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
}

// Build a test copy of the extension pointed at the mock server.
function buildTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-ext-'));
  fs.cpSync(EXT_SRC, dir, { recursive: true });
  const apiPath = path.join(dir, 'utils/api.js');
  fs.writeFileSync(apiPath, fs.readFileSync(apiPath, 'utf8').replace(/const API_URL = '[^']+'/, `const API_URL = '${MOCK}/v1/messages'`));
  const gemPath = path.join(dir, 'utils/gemini.js');
  fs.writeFileSync(gemPath, fs.readFileSync(gemPath, 'utf8').replace(/const API_BASE = '[^']+'/, `const API_BASE = '${MOCK}/v1beta'`));
  const mPath = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  m.host_permissions.push(`${MOCK}/*`);
  fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
  return dir;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Helpers over the mock's request log.
const getLog = async () => (await fetch(`${MOCK}/__log`)).json();
const textOf = (e) => { const c = e.body.messages?.[0]?.content; return typeof c === 'string' ? c : (c || []).filter(b => b.type === 'text').map(b => b.text).join('\n'); };
const isWriter = (e) => e.path === '/v1/messages' && !(e.body.tools || []).length && !/single word: OK/.test(textOf(e));
const isResearch = (e) => e.path === '/v1/messages' && (e.body.tools || []).some(t => t.name === 'web_search');
const ctxOf = (e) => JSON.parse(/<context>\s*([\s\S]*?)\s*<\/context>/.exec(textOf(e))[1]);
const reqsOf = (e) => /<requirements>\s*([\s\S]*?)\s*<\/requirements>/.exec(textOf(e))[1];
const lastWriter = async () => (await getLog()).filter(isWriter).pop();
// Put the caret inside the sentence containing `needle` and click, like a user would.
const clickInMessage = (page, needle) => page.evaluate((n) => {
  const ta = document.getElementById('message');
  const i = ta.value.indexOf(n);
  if (i < 0) return false;
  ta.focus();
  ta.setSelectionRange(i + 1, i + 1);
  ta.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
}, needle);

async function main() {
  const server = require('./mock-server');
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const extDir = buildTestExtension();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-profile-'));
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: SHOTS ? 2 : 1,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  // Serve fixtures for linkedin.com URLs.
  await ctx.route('https://www.linkedin.com/**', route => {
    const url = route.request().url();
    if (/\/in\/me\/?$/.test(url)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<script>location.replace("/in/sam-rivera-test/")</script>' });
    const file = /\/in\/sheena/.test(url) ? 'profile-multi.html' : /\/in\/rahul/.test(url) ? 'profile-real.html' : /\/in\/alex/.test(url) ? 'profile-modern.html' : /\/in\/sam-rivera/.test(url) ? 'profile-me.html' : /\/in\//.test(url) ? 'profile-classic.html' : null;
    if (!file) return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><h1>Feed</h1></body></html>' });
    route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8') });
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  console.log(`extension ${extId}`);

  const li = await ctx.newPage();
  await li.goto('https://www.linkedin.com/in/priya-sharma-test/');
  await li.waitForSelector('h1');
  await sleep(500);
  const liTabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.linkedin.com/in/priya-sharma-test/*' }))[0].id);

  const panelUrl = `chrome-extension://${extId}/sidepanel.html?tabId=${liTabId}`;
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 400, height: 860 });
  const shot = async (name, page = panel) => { if (SHOTS) { await page.waitForTimeout(450); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), scale: 'device' }); } };

  // ── 1. Onboarding ────────────────────────────────────────────────────────
  console.log('\nOnboarding');
  await panel.goto(panelUrl);
  await panel.waitForSelector('#onboarding:not(.hidden)');
  check('onboarding shown on first run', true);
  check('no "reload the extension" banner when builds match', await panel.isHidden('#stale-banner'));
  await shot('01-onboarding');
  check('free mode offered, no key required', await panel.isVisible('#ob-free'));
  await panel.fill('#ob-key', 'sk-ant-wrong-key-zzzzzzzzzzzzzzzzzzzzzz');
  await panel.click('#ob-test');
  await panel.waitForSelector('#ob-key-status[data-status="invalid"]');
  check('bad API key rejected in plain words', (await panel.textContent('#ob-key-status')).includes('rejected your API key'));
  check('bad key not saved', !(await sw.evaluate(() => chrome.storage.local.get('userApiKey'))).userApiKey);
  await panel.fill('#ob-key', KEY);
  await panel.click('#ob-test');
  await panel.waitForSelector('#ob-key-status[data-status="valid"]');
  check('valid API key accepted', (await panel.textContent('#ob-key-status')).includes('AI mode is on'));
  const testCall = (await getLog()).pop();
  check('key test uses direct-browser header + Haiku', testCall.headers.browser === 'true' && testCall.body.model === 'claude-haiku-5-5' && testCall.headers.version === '2023-06-01', testCall.headers);
  await panel.waitForSelector('[data-ob="2"]:not(.hidden)');
  await panel.fill('#ob-name', 'Sam Rivera');
  await panel.fill('#ob-bio', 'Final-year CS student into ML infra.');
  await panel.click('#ob-next');
  await panel.click('#ob-done');
  await panel.waitForSelector('#onboarding.hidden', { state: 'attached' });
  check('chip shows AI mode', (await panel.textContent('#mode-chip')) === 'AI · Haiku 5.5', await panel.textContent('#mode-chip'));

  // ── 2. Profile pickup ────────────────────────────────────────────────────
  console.log('\nProfile');
  await panel.waitForFunction(() => document.getElementById('p-name').textContent === 'Priya Sharma');
  check('light read shows profile card without scrolling', true);
  check('headline read from top card', (await panel.textContent('#p-headline')).includes('Senior ML Engineer'));
  check('location read (non-Indian)', (await panel.textContent('#p-meta')).includes('Berlin, Germany'));
  await shot('02-profile');

  // ── 3. Quick generate ────────────────────────────────────────────────────
  console.log('\nQuick mode');
  const scrollBefore = await li.evaluate(() => { window.scrollTo(0, 120); return window.scrollY; });
  await panel.keyboard.press('Control+Enter');
  await panel.waitForSelector('#result:not(.hidden)', { timeout: 15000 });
  const msg1 = await panel.inputValue('#message');
  check('message generated', msg1.startsWith('Hi Priya'), msg1);
  check('page scroll restored after full read', (await li.evaluate(() => window.scrollY)) === scrollBefore);
  const sess = await sw.evaluate(() => Sessions.get('priya-sharma-test'));
  const p = sess.profile;
  check('experience parsed: grouped roles', p.experienceEntries[0]?.title === 'Senior ML Engineer' && p.experienceEntries[0]?.company === 'Lumen Analytics', p.experienceEntries);
  check('experience parsed: plain role', p.experienceEntries.some(e => e.title === 'Data Scientist' && e.company === 'Zalando'), p.experienceEntries);
  check('past companies', p.pastCompanies.includes('Zalando'), p.pastCompanies);
  check('skills parsed without endorsement noise', p.skills.join() === 'Machine Learning,Feature Engineering,Python,Apache Spark', p.skills);
  check('education parsed', p.educationEntries[0] === 'TU Munich — MSc, Informatics', p.educationEntries);
  check('recent posts parsed', p.recentPosts.length === 2, p.recentPosts);
  check('about parsed', p.about.startsWith('I build the plumbing'));

  let log = await getLog();
  const qe = log.filter(isWriter).pop();
  const qctx = ctxOf(qe);
  check('writer: Haiku 5.5, low effort, room for thinking', qe.body.model === 'claude-haiku-5-5' && qe.body.output_config?.effort === 'low' && qe.body.max_tokens >= 4000, [qe.body.model, qe.body.max_tokens]);
  check('writer: system prompt forbids invented facts', /Never invent/.test(qe.body.system));
  check('writer: format + hard limit in requirements', /connection request note/.test(reqsOf(qe)) && /HARD LIMIT/.test(reqsOf(qe)), reqsOf(qe));
  check('writer: profile + sender in context', qctx.recipient.name === 'Priya Sharma' && qctx.recipient.recentPosts.length === 2 && qctx.sender.name === 'Sam Rivera', qctx.sender);
  check('thinking block ignored, only text kept', !msg1.includes('sig') && msg1.length > 20);
  check('cost shown for AI message', /Haiku 5\.5 · (<?\$0\.\d+)/.test(await panel.textContent('#step-note')), await panel.textContent('#step-note'));
  check('meter shows note limit', (await panel.textContent('#meter-text')).includes('/ 300'));
  await shot('03-quick-result');

  // ── 4. Persistence across panel close ────────────────────────────────────
  console.log('\nPersistence');
  await panel.close();
  const panel2 = await ctx.newPage();
  await panel2.setViewportSize({ width: 400, height: 860 });
  await panel2.goto(panelUrl);
  await panel2.waitForSelector('#result:not(.hidden)');
  check('message survives closing the panel', (await panel2.inputValue('#message')) === msg1);

  // Deep mode started, panel closed mid-run, reopened → finished result.
  await panel2.click('#opt-mode [data-value="deep"]');
  await panel2.click('#primary-btn');
  await panel2.waitForSelector('#stepper .step[data-step="research"][data-state="running"]');
  await shot('04-deep-running', panel2);
  await panel2.close();
  await sleep(2500);
  const panel3 = await ctx.newPage();
  await panel3.setViewportSize({ width: 400, height: 860 });
  await panel3.goto(panelUrl);
  await panel3.waitForFunction(() => document.querySelector('#stepper .step[data-step="write"]').dataset.state === 'done', null, { timeout: 15000 });
  check('deep run completes while panel was closed', true);
  check('versions kept (2 / 2)', (await panel3.textContent('#v-label')).trim() === '2 / 2');

  // ── 5. Hooks selection ───────────────────────────────────────────────────
  console.log('\nDeep mode hooks');
  log = await getLog();
  const rs = log.filter(isResearch);
  check('research: Sonnet 5.5 + web_search_20260209', rs[0].body.model === 'claude-sonnet-5-5' && rs[0].body.tools[0].type === 'web_search_20260209', rs[0].body.tools);
  check('research: refusal fallback enabled', rs[0].body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(rs[0].headers.beta || ''));
  check('research: pause_turn resumed', rs.length === 2 && rs[1].body.messages.length === 2 && rs[1].body.messages[1].role === 'assistant');
  const hookTexts = await panel3.$$eval('#hooks-list .hook > span', xs => xs.map(x => x.textContent));
  check('hook with a made-up source URL dropped', !hookTexts.some(t => t.includes('Forbes')), hookTexts);
  check('web hooks + their post', hookTexts.length === 3 && hookTexts[0].includes('Series B') && hookTexts[2].includes('posted'), hookTexts);
  check('each web hook links its source', (await panel3.$$eval('#hooks-list .hook-src', xs => xs.map(x => x.textContent))).join().includes('techcrunch.com'));
  check('all 3 preselected', (await panel3.locator('#hooks-list input:checked').count()) === 3);
  await shot('05-deep-hooks', panel3);
  check('deep run cost includes research', /Haiku 5\.5 · \$0\.0[1-9]\d/.test(await panel3.textContent('#step-note')), await panel3.textContent('#step-note'));
  await panel3.locator('#hooks-list input').nth(0).uncheck();
  await panel3.waitForFunction(() => /Write with 2 hooks/.test(document.getElementById('primary-label').textContent));
  check('button reflects hook selection', true);
  await panel3.click('#primary-btn');
  await panel3.waitForFunction(() => document.getElementById('v-label').textContent.trim() === '3 / 3', null, { timeout: 15000 });
  log = await getLog();
  const dctx = ctxOf(log.filter(isWriter).pop());
  check('only selected hooks sent to writer, with sources', dctx.research_hooks.length === 2 && !dctx.research_hooks[0].hook.includes('Series B') && dctx.research_hooks[0].source.includes('pydata'), dctx.research_hooks);
  check('writer gets your name + bio', dctx.sender.name === 'Sam Rivera' && dctx.sender.bio.includes('Final-year'), dctx.sender);
  check('research did not re-run for rewrite', log.filter(isResearch).length === 2);
  await panel3.click('#v-prev');
  check('version navigation', (await panel3.textContent('#v-label')).trim() === '2 / 3');

  console.log('\nEvidence: click a sentence');
  check('hint tells you sentences are clickable', await panel3.isVisible('#ev-hint'));
  check('progress steps collapse once written', !(await panel3.isVisible('#stepper')) && await panel3.isVisible('#step-note'));
  await clickInMessage(panel3, 'Series B');
  await panel3.waitForSelector('#evidence:not(.hidden)');
  check('evidence card opens on click', (await panel3.textContent('#ev-title')) === 'Where this came from');
  const ev1 = await panel3.textContent('#ev-list');
  check('web claim traced to its article, with a link', ev1.includes('Web: techcrunch.com') && (await panel3.getAttribute('#ev-list .ev-link', 'href')).startsWith('https://techcrunch.com/'), ev1);
  check('clicked sentence highlighted in the message', (await panel3.locator('#msg-backdrop .hl.active').count()) === 1);
  check('hint goes away once used', !(await panel3.isVisible('#ev-hint')));
  await shot('19-evidence', panel3);
  await panel3.click('#ev-close');
  check('evidence card closes', await panel3.isHidden('#evidence') && (await panel3.locator('#msg-backdrop .hl.active').count()) === 0);

  // ── 6. Over-limit + trim ─────────────────────────────────────────────────
  console.log('\nLimits');
  await panel3.click('#opt-mode [data-value="quick"]');
  await panel3.click('#context-box summary');
  await panel3.fill('#opt-context', 'LONG');
  await sleep(500);
  await panel3.click('#regen-btn');
  await panel3.waitForFunction(() => document.getElementById('v-label').textContent.trim() === '4 / 4', null, { timeout: 15000 });
  await panel3.click('#set-note-limit button[data-value="200"]').catch(() => {});
  await panel3.click('#tab-settings');
  await panel3.click('#set-note-limit button[data-value="200"]');
  await panel3.click('#tab-compose');
  await panel3.waitForSelector('#fix-row:not(.hidden)');
  check('over-limit warning for free account (200)', (await panel3.textContent('#fix-text')).includes('200-character limit'), await panel3.textContent('#fix-text'));
  await shot('06-over-limit', panel3);
  await panel3.click('#fit-btn');
  const trimmed = await panel3.inputValue('#message');
  check('trim to fit ≤ 200 at sentence end', trimmed.length <= 200 && /[.!?…]$/.test(trimmed), trimmed.length);
  await panel3.fill('#opt-context', '');
  await sleep(500);

  // ── 7. Insert into LinkedIn ──────────────────────────────────────────────
  console.log('\nInsert');
  await panel3.click('#insert-btn');
  await panel3.waitForFunction(() => /No LinkedIn box open/.test(document.getElementById('toast-text').textContent));
  check('no box open → copies and explains', (await panel3.textContent('#toast-text')).includes('Add a note'));
  await li.click('#connect');
  await panel3.click('#insert-btn');
  await sleep(300);
  check('inserted into invite note', (await li.inputValue('#custom-message')) === trimmed);
  check('toast offers mark as sent', (await panel3.textContent('#toast-action')).includes('Mark as sent'));
  await shot('07-inserted', li);
  await panel3.click('#toast-action');
  await sleep(400);

  await li.click('#message');
  await panel3.click('#opt-format [data-value="dm"]');
  await panel3.click('#regen-btn');
  await panel3.waitForFunction(() => document.getElementById('v-label').textContent.trim() === '6 / 6', null, { timeout: 15000 });
  await li.evaluate(() => document.getElementById('invite').classList.remove('open'));
  await panel3.click('#insert-btn');
  await sleep(300);
  check('inserted into message composer', (await li.textContent('.msg-form__contenteditable')).startsWith('Hi Priya, thanks for connecting'));

  // ── 8. Tracker ───────────────────────────────────────────────────────────
  console.log('\nTracker');
  await panel3.click('#tab-tracker');
  await panel3.waitForSelector('.contact');
  check('one tracker entry per person', (await panel3.locator('.contact').count()) === 1);
  check('status is Sent', (await panel3.locator('.status-select').inputValue()) === 'sent');
  // Make it due and fire the reminder check.
  await sw.evaluate(async () => {
    const items = await ContactStore.list();
    items[0].followUpAt = Date.now() - 1000; items[0].sentAt = Date.now() - 6 * 864e5;
    await chrome.storage.local.set({ contacts: items });
  });
  await panel3.waitForSelector('#due-badge:not(.hidden)');
  check('follow-up badge on Tracker tab', (await panel3.textContent('#due-badge')) === '1');
  await panel3.click('[data-filter="due"]');
  check('follow-up filter', (await panel3.locator('.contact').count()) === 1);
  await panel3.fill('#t-search', 'zzz');
  await sleep(200);
  check('search filters', (await panel3.locator('.contact').count()) === 0);
  await panel3.fill('#t-search', '');
  await panel3.click('[data-filter="all"]');
  await sleep(200);
  const [dl] = await Promise.all([panel3.waitForEvent('download'), panel3.click('#t-export')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check('CSV export', csv.includes('"Priya Sharma"') && csv.split('\n')[0].includes('profileUrl'));
  await shot('08-tracker', panel3);

  // ── 8b. In-app navigation (URL changes before the DOM does) ──────────────
  console.log('\nIn-app navigation');
  await panel3.click('#tab-compose');
  await li.evaluate(() => {
    history.pushState({}, '', '/in/jordan-lee-test/');
    setTimeout(() => {
      document.querySelector('main').innerHTML =
        '<section><h1>Jordan Lee</h1><p>Staff Engineer at Acme | Infra</p><p>Austin, Texas, United States</p></section>';
    }, 1800);
  });
  await panel3.waitForFunction(() => document.getElementById('p-name').textContent === 'Jordan Lee', null, { timeout: 12000 });
  const sj = await sw.evaluate(() => Sessions.get('jordan-lee-test'));
  check('stale DOM not read as the new person', sj.profile.name === 'Jordan Lee' && sj.profile.currentCompany === 'Acme', sj.profile.name);

  // ── 9. SPA-ish navigation to a different layout ──────────────────────────
  console.log('\nSecond profile (p-tag layout)');
  await li.goto('https://www.linkedin.com/in/alex-chen-test/');
  await panel3.click('#tab-compose');
  await panel3.waitForFunction(() => document.getElementById('p-name').textContent === 'Alex Chen', null, { timeout: 8000 }).catch(async (e) => {
    console.log('DEBUG', await panel3.textContent('#p-name'), await panel3.textContent('#p-headline'), JSON.stringify(await sw.evaluate(() => Sessions.get('alex-chen-test'))).slice(0, 400));
    throw e;
  });
  check('panel follows navigation', true);
  check('message area reset for new person', await panel3.locator('#result.hidden').count() === 1);
  await panel3.click('#opt-format [data-value="inmail"]');
  await panel3.click('#primary-btn');
  await panel3.waitForSelector('#result:not(.hidden)', { timeout: 15000 });
  const s2 = await sw.evaluate(() => Sessions.get('alex-chen-test'));
  check('fallback parser: title/company', s2.profile.experienceEntries[0]?.title === 'Product Designer' && s2.profile.currentCompany === 'Northwind', s2.profile.experienceEntries);
  check('fallback parser: second role not polluted by location', s2.profile.experienceEntries[1]?.title === 'UX Designer' && s2.profile.experienceEntries[1]?.company === 'Shopify', s2.profile.experienceEntries);
  check('headline + location', s2.profile.headline.includes('Product Designer @ Northwind') && s2.profile.location === 'Toronto, Ontario, Canada', [s2.profile.headline, s2.profile.location]);
  check('newer layout: About with a "… more" button is read', s2.profile.about.includes('Designer who codes') && s2.profile.about.includes('motion design') && !/more$/.test(s2.profile.about), s2.profile.about);
  check('newer layout: post read, author headline skipped', s2.profile.recentPosts.length === 1 && s2.profile.recentPosts[0].startsWith('Shipped dark mode'), s2.profile.recentPosts);
  check('InMail shows subject + body meter', (await panel3.inputValue('#message')).startsWith('Subject:') && (await panel3.textContent('#meter-text')).includes('/ 1900'));

  // ── 9b. Real LinkedIn markup: posts with nested links, <br> About, skills ─
  console.log('\nReal-markup profile');
  await li.goto('https://www.linkedin.com/in/rahul-real-test/');
  await panel3.waitForFunction(() => document.getElementById('p-name').textContent === 'Rahul Verma', null, { timeout: 8000 });
  check('quick read says posts & skills come with the full read', (await panel3.textContent('#p-quality')).includes('posts & skills load on Generate'), await panel3.textContent('#p-quality'));
  await panel3.click('#refresh-profile');
  await panel3.waitForFunction(() => /post/.test(document.getElementById('p-quality').textContent) && !/load on Generate/.test(document.getElementById('p-quality').textContent), null, { timeout: 10000 });
  const rv = (await sw.evaluate(() => Sessions.get('rahul-real-test'))).profile;
  check('posts with nested hashtag links are read', rv.recentPosts.length === 2 && rv.recentPosts[0].includes('open-sourced RoboNav') && rv.recentPosts[0].includes('#robotics'), rv.recentPosts);
  check('author headline in a post card is not mistaken for the post', !rv.recentPosts.some(t => t.includes('AWS Certified')), rv.recentPosts);
  check('content-free posts ("Congratulations! 🎉") are skipped', !rv.recentPosts.some(t => /Congratulations/.test(t)), rv.recentPosts);
  check('follower counts / actor lines are not mistaken for posts', !rv.recentPosts.some(t => /followers|2w •|comments/.test(t)));
  check('skills read from nested markup', rv.skills.join('|') === 'Robot Operating System (ROS)|Python (Programming Language)', rv.skills);
  check('About text split by <br> is read whole', rv.about.includes('warehouse robots') && rv.about.includes('ROS2 and SLAM'), rv.about);
  check('review fields show posts and skills', (await panel3.inputValue('[data-edit="recentPosts"]')).includes('RoboNav') && (await panel3.inputValue('[data-edit="skills"]')).includes('Python'));

  console.log('\nSeveral current roles + inner scroll panel');
  await li.goto('https://www.linkedin.com/in/sheena-multi-test/');
  await panel3.waitForFunction(() => document.getElementById('p-name').textContent === 'Dr. Sheena Christabel Pravin', null, { timeout: 8000 });
  const sh0 = (await sw.evaluate(() => Sessions.get('sheena-multi-test'))).profile;
  check('company from the profile header, not empty', sh0.currentCompany === 'MEDxAI INNOVATIONS Pvt. Ltd.', sh0.currentCompany);
  check('roles split out of a multi-role headline', sh0.currentRoles.length === 3 && sh0.currentRoles[2].title === 'CEO' && sh0.currentRoles[0].company.startsWith('Vellore'), sh0.currentRoles);
  check('current title matches the header company', sh0.currentTitle === 'CEO', sh0.currentTitle);
  await panel3.click('#refresh-profile');
  await panel3.waitForFunction(() => /roles/.test(document.getElementById('p-quality').textContent), null, { timeout: 15000 });
  const sh = (await sw.evaluate(() => Sessions.get('sheena-multi-test'))).profile;
  check('lazy sections load when an inner panel scrolls', sh.experienceEntries.length === 4 && sh.about.includes('medical AI') && sh.skills.length === 2, [sh.experienceEntries.length, sh.about, sh.skills]);
  check('all current roles kept from Experience', sh.currentRoles.length === 3 && sh.currentTitle === 'Chief Executive Officer' && sh.currentCompany === 'MEDxAI INNOVATIONS Pvt. Ltd.', [sh.currentTitle, sh.currentRoles]);
  check('only ended jobs count as past companies', sh.pastCompanies.join() === 'SSN College of Engineering', sh.pastCompanies);
  check('inner panel scroll position restored', (await li.evaluate(() => document.getElementById('workspace').scrollTop)) === 0);
  check('recipient: founder/CEO', (await panel3.textContent('#rc-chip')).includes('Founder'));

  await li.goto('https://www.linkedin.com/in/alex-chen-test/');
  await panel3.waitForFunction(() => document.getElementById('p-name').textContent === 'Alex Chen', null, { timeout: 8000 });
  await panel3.waitForSelector('#result:not(.hidden)');

  // ── 10. Errors ───────────────────────────────────────────────────────────
  console.log('\nErrors');
  await panel3.evaluate(() => { document.getElementById('context-box').open = true; });
  await panel3.fill('#opt-context', 'FLAKY');
  await sleep(500);
  await panel3.click('#regen-btn');
  await panel3.waitForFunction(() => document.getElementById('v-label').textContent.trim() === '2 / 2', null, { timeout: 20000 });
  check('529 overloaded is retried transparently', (await getLog()).some(e => e.flaked));
  await panel3.fill('#opt-context', 'NOCREDIT');
  await sleep(500);
  await panel3.click('#regen-btn');
  await panel3.waitForSelector('#error-banner:not(.hidden)', { timeout: 10000 });
  check('credit error explained', (await panel3.textContent('#error-text')).includes('credit balance is too low'));
  await panel3.fill('#opt-context', '');
  await sleep(500);
  await sw.evaluate(() => chrome.storage.local.set({ userApiKey: 'sk-ant-revoked-key-yyyyyyyyyyyyyyyyyyyy' }));
  await sleep(300);
  await panel3.click('#regen-btn');
  await panel3.waitForFunction(() => /rejected your API key/.test(document.getElementById('error-text').textContent), null, { timeout: 10000 });
  check('auth error shown in plain words', true);
  check('error action routes to Settings', (await panel3.textContent('#error-action')) === 'Open Settings');
  check('chip flips to key problem', (await panel3.textContent('#mode-chip')) === 'Key problem', await panel3.textContent('#mode-chip'));
  await shot('09-error', panel3);
  const beforeFree = (await getLog()).filter(isWriter).length;
  const vFree = await panel3.textContent('#v-label');
  await panel3.click('#error-free');
  await panel3.waitForFunction((b) => document.getElementById('v-label').textContent !== b, vFree, { timeout: 10000 });
  check('"Write in free mode" recovers without the API', (await getLog()).filter(isWriter).length === beforeFree && /free mode/.test(await panel3.textContent('#step-note')));
  await sw.evaluate((k) => chrome.storage.local.set({ userApiKey: k, keyStatus: null }), KEY);
  await sleep(300);

  // ── 11. Trust layer: import me, common ground, fact check, fix with AI ───
  console.log('\nImport my LinkedIn');
  await li.goto('https://www.linkedin.com/in/priya-sharma-test/');
  await panel3.waitForFunction(() => document.getElementById('p-name').textContent === 'Priya Sharma', null, { timeout: 8000 });
  check('nudge to import shown', await panel3.isVisible('#ground-nudge'));
  await panel3.evaluate(() => { document.getElementById('context-box').open = true; });
  await panel3.fill('#opt-context', '');
  await panel3.click('#tab-settings');
  await panel3.click('#import-me');
  await panel3.waitForSelector('#me-card:not(.hidden)', { timeout: 30000 }).catch(async (e) => {
    console.log('DEBUG', await panel3.textContent('#toast-text'), ctx.pages().map(p => p.url()));
    throw e;
  });
  check('own profile imported', (await panel3.textContent('#me-name')) === 'Sam Rivera');
  check('import tab closed again', ctx.pages().every(p => !p.url().includes('sam-rivera')));
  check('import summary', (await panel3.textContent('#me-meta')).includes('2 schools'));
  const me = await sw.evaluate(async () => (await chrome.storage.local.get('myProfile')).myProfile);
  check('ended internship is not your current job', me.currentCompany === 'TU Delft' && me.pastCompanies.includes('Zalando'), [me.currentCompany, me.pastCompanies]);
  await shot('13-settings-me', panel3);

  console.log('\nCommon ground');
  await panel3.click('#tab-compose');
  await panel3.waitForSelector('#ground:not(.hidden)');
  const ground = await panel3.$$eval('#ground-list .hook > span', xs => xs.map(x => x.textContent));
  check('shared school found via acronym', ground.includes('You both studied at IIT Bombay'), ground);
  check('shared company found', ground.some(t => t.includes('Zalando')), ground);
  check('top 2 preselected', (await panel3.locator('#ground-list input:checked').count()) === 2);
  check('nudge hidden after import', !(await panel3.isVisible('#ground-nudge')));
  await panel3.click('#opt-format [data-value="note"]');
  await panel3.click('#opt-mode [data-value="quick"]');
  const before = await panel3.textContent('#v-label');
  await panel3.click('#regen-btn');
  await panel3.waitForFunction((b) => document.getElementById('v-label').textContent !== b, before, { timeout: 15000 });
  const qg = await lastWriter();
  check('common ground sent to the writer', /Genuine shared background.*IIT Bombay/.test(reqsOf(qg)) && ctxOf(qg).shared_background.includes('You both studied at IIT Bombay'), reqsOf(qg));
  check('your imported profile sent as sender context', ctxOf(qg).sender.profile?.name === 'Sam Rivera');
  const mg = await panel3.inputValue('#message');
  check('message opens with common ground', mg.includes('fellow IIT Bombay alum'), mg);

  console.log('\nFact check');
  await panel3.waitForFunction(() => /claims? backed/.test(document.getElementById('check-summary').textContent));
  check('all claims backed on a true message', /(All \d+ claims|^1 claim) backed/.test(await panel3.textContent('#check-summary')), await panel3.textContent('#check-summary'));
  await panel3.click('#check-toggle');
  const factText = await panel3.textContent('#facts-list');
  check('shows evidence source', factText.includes('Shared background') || factText.includes('Their'), factText);
  await shot('14-check-ok', panel3);

  await panel3.evaluate(() => { document.getElementById('context-box').open = true; });
  await panel3.fill('#opt-context', 'HALLUCINATE');
  await sleep(500);
  const b2 = await panel3.textContent('#v-label');
  await panel3.click('#regen-btn');
  await panel3.waitForFunction((b) => document.getElementById('v-label').textContent !== b, b2, { timeout: 15000 });
  await panel3.waitForFunction(() => document.getElementById('check').dataset.level === 'warn');
  const summary = await panel3.textContent('#check-summary');
  check('hallucinated claim flagged in summary', /\d\/\d claims backed/.test(summary), summary);
  check('panel auto-opens on problems', await panel3.isVisible('#check-body'));
  const flagged = await panel3.textContent('#facts-list');
  check('names the unsupported terms', flagged.includes('Google') && flagged.includes('promotion'), flagged);
  check('inline highlight on the missing term', (await panel3.locator('#msg-backdrop mark.miss').count()) >= 1);
  check('cliché flagged', (await panel3.textContent('#lint-list')).includes('I came across your profile'));
  await clickInMessage(panel3, 'promotion');
  await panel3.waitForSelector('#evidence[data-status="unverified"]');
  const ev2 = await panel3.textContent('#ev-list');
  check('clicking an invented claim says what is missing', (await panel3.textContent('#ev-title')).includes('Couldn’t verify') && ev2.includes('Google') && ev2.includes('Not found'), ev2);
  check('…and shows what is backed in the same sentence', !ev2.includes('“Priya”'));
  await panel3.keyboard.press('End');
  await panel3.keyboard.type(' ');
  check('typing closes the card (offsets change)', await panel3.isHidden('#evidence'));
  await panel3.keyboard.press('Backspace');
  await shot('15-check-flagged', panel3);

  await panel3.fill('#opt-context', '');
  await sleep(500);
  const b3 = await panel3.textContent('#v-label');
  await panel3.click('#fix-ai-btn');
  await panel3.waitForFunction((b) => document.getElementById('v-label').textContent !== b, b3, { timeout: 15000 });
  const fx = reqsOf(await lastWriter());
  check('fix request lists the unsupported sentence', /unsupported claims[\s\S]*promotion to Director at Google/.test(fx), fx);
  check('fix request lists the cliché', /Avoid these clichés[\s\S]*came across your profile/.test(fx));
  check('fix request includes the previous draft', /Previous draft: "{3}Hi Priya, congrats/.test(fx));
  await panel3.waitForFunction(() => document.getElementById('check').dataset.level === 'ok', null, { timeout: 5000 }).catch(() => {});
  check('fixed version passes the check', (await panel3.evaluate(() => document.getElementById('check').dataset.level)) === 'ok', await panel3.textContent('#check-summary'));
  await shot('16-check-fixed', panel3);

  // Typing a false claim re-checks live.
  await panel3.click('#message');
  await panel3.keyboard.press('Control+End');
  await panel3.keyboard.type(' Congrats on the IPO at Meta!');
  await panel3.waitForFunction(() => /Meta/.test(document.getElementById('facts-list').textContent), null, { timeout: 3000 });
  check('live re-check while editing', true);

  console.log('\nSelf profile');
  await li.goto('https://www.linkedin.com/in/sam-rivera-test/');
  await panel3.waitForSelector('#self-banner:not(.hidden)', { timeout: 8000 });
  check('own profile recognised', true);
  check('no common ground with yourself', (await panel3.locator('#ground.hidden').count()) === 1);

  console.log('\nInsights');
  await sw.evaluate(async () => {
    const mk = (id, status, common) => ({ id, name: id, status, profileUrl: '', message: 'x', format: 'note', updatedAt: Date.now(), signals: { common, mode: 'quick', format: 'note', tone: 'Neutral' } });
    const items = await ContactStore.list();
    await chrome.storage.local.set({ contacts: [...items,
      mk('a', 'replied', 1), mk('b', 'replied', 2), mk('c', 'sent', 1),
      mk('d', 'sent', 0), mk('e', 'sent', 0), mk('f', 'replied', 0)] });
  });
  await panel3.click('#tab-tracker');
  await panel3.waitForSelector('#insights:not(.hidden) .ins-big');
  const ins = await panel3.textContent('#insights');
  check('reply rate shown', ins.includes('reply rate'), ins);
  check('small-sample caveat shown', (await panel3.textContent('#insights')).includes('treat this as a hint'));
  check('surfaces what works (common ground)', /with common ground got 50% replies vs 33% without \(4 vs 3 sent\)/.test(ins), ins);
  await shot('17-insights', panel3);

  // ── 12. Free mode (no API key) ───────────────────────────────────────────
  console.log('\nFree mode');
  await panel3.click('#tab-settings');
  await panel3.click('#remove-key');
  await panel3.waitForFunction(() => document.getElementById('mode-chip').textContent === 'Free mode');
  check('removing the key switches to free mode', true);
  check('no model field without a key', await panel3.isHidden('#model-field') && await panel3.isHidden('#gemini-model-field'));
  await li.goto('https://www.linkedin.com/in/priya-sharma-test/');
  await panel3.click('#tab-compose');
  await panel3.waitForFunction(() => document.getElementById('p-name').textContent === 'Priya Sharma', null, { timeout: 8000 });
  await panel3.click('#opt-mode [data-value="quick"]');
  await panel3.click('#opt-format [data-value="note"]');
  await panel3.evaluate(() => { document.getElementById('context-box').open = true; });
  await panel3.fill('#opt-context', '');
  await sleep(400);
  const callsBefore = (await getLog()).length;
  let vb = await panel3.textContent('#v-label');
  await panel3.click('#regen-btn');
  await panel3.waitForFunction((b) => document.getElementById('v-label').textContent !== b, vb, { timeout: 10000 });
  const free1 = await panel3.inputValue('#message');
  check('free mode makes no network calls', (await getLog()).length === callsBefore);
  check('free note fits the 200-char limit', free1.length <= 200, free1.length);
  check('free note opens with verified common ground', /fellow IIT Bombay alum|both spent time at Zalando/.test(free1), free1);
  check('free note avoids upstream’s cliché', !/came across your profile/i.test(free1));
  await panel3.waitForFunction(() => document.getElementById('check').dataset.level === 'ok', null, { timeout: 3000 }).catch(() => {});
  check('free note passes the fact check', (await panel3.evaluate(() => document.getElementById('check').dataset.level)) === 'ok', await panel3.textContent('#check-summary'));
  check('Fix with AI needs a key', await panel3.isDisabled('#fix-ai-btn'));
  vb = await panel3.textContent('#v-label');
  await panel3.click('#regen-btn');
  await panel3.waitForFunction((b) => document.getElementById('v-label').textContent !== b, vb, { timeout: 10000 });
  check('another version is actually different', (await panel3.inputValue('#message')) !== free1);
  await shot('18-free-mode', panel3);

  console.log('\nRecipient-aware purpose');
  check('recipient chip shows who they are', (await panel3.textContent('#rc-chip')).includes('Senior engineer') && (await panel3.textContent('#rc-why')).includes('Senior ML Engineer'));
  await panel3.selectOption('#opt-purpose', 'Auto');
  check('Auto explains its pick', (await panel3.textContent('#purpose-hint')).includes('Career advice'));
  await panel3.selectOption('#opt-purpose', 'Job');
  await panel3.waitForSelector('#purpose-warn:not(.hidden)');
  check('warns when the purpose does not fit', (await panel3.textContent('#purpose-warn-text')).includes('probably doesn’t hire directly'));
  await panel3.click('#purpose-warn-btn');
  check('one click switches to the suggested purpose', (await panel3.inputValue('#opt-purpose')) === 'Advice' && await panel3.isHidden('#purpose-warn'));
  vb = await panel3.textContent('#v-label');
  await panel3.click('#regen-btn');
  await panel3.waitForFunction((b) => document.getElementById('v-label').textContent !== b, vb, { timeout: 10000 });
  check('the ask matches (career advice)', /question about your path|advice/i.test(await panel3.inputValue('#message')), await panel3.inputValue('#message'));
  await shot('20-recipient', panel3);

  await panel3.click('#opt-mode [data-value="deep"]');
  check('deep hint explains free research', (await panel3.textContent('#mode-hint')).includes('from their profile'));
  // Versions are capped at 12 per person, so wait for a new version id rather than the counter.
  const lastId = async () => (await sw.evaluate(() => Sessions.get('priya-sharma-test'))).versions.slice(-1)[0]?.id;
  const idBefore = await lastId();
  await panel3.click('#primary-btn');
  for (let i = 0; i < 50 && (await lastId()) === idBefore; i++) await sleep(200);
  const freeHooks = await panel3.$$eval('#hooks-list .hook > span', xs => xs.map(x => x.textContent));
  check('free deep mode: profile hooks, no web calls', freeHooks.some(t => t.startsWith('Recently posted')) && (await getLog()).length === callsBefore, freeHooks);
  await panel3.click('#opt-mode [data-value="quick"]');

  // ── 12b. Gemini (free-tier key) ──────────────────────────────────────────
  console.log('\nGemini');
  await panel3.click('#opt-mode [data-value="quick"]');
  await panel3.click('#tab-settings');
  await panel3.fill('#api-key', 'AIzaWRONG-key-zzzzzzzzzzzzzzzzzzzzzzzzzzz');
  await panel3.click('#test-key-btn');
  await panel3.waitForSelector('#key-status[data-status="invalid"]');
  check('bad Gemini key explained', (await panel3.textContent('#key-status')).includes('Google rejected your Gemini API key'));
  await panel3.fill('#api-key', 'AIzaTEST-valid-key-0123456789abcdefghijk');
  await panel3.click('#test-key-btn');
  await panel3.waitForSelector('#key-status[data-status="valid"]');
  check('Gemini key works; newest stable Flash picked (not TTS/Lite/Pro)', (await panel3.textContent('#key-status')).includes('Gemini 2.5 Flash'), await panel3.textContent('#key-status'));
  await panel3.waitForFunction(() => document.getElementById('mode-chip').textContent === 'AI · Gemini 2.5 Flash');
  check('chip shows Gemini', true);
  check('Claude model picker hidden for a Gemini key', await panel3.isHidden('#model-field'));
  check('Gemini model shown as auto-picked', (await panel3.textContent('#gemini-model-field')).includes('Gemini 2.5 Flash'));
  await panel3.click('#tab-compose');
  let gb = await panel3.textContent('#step-note');
  await panel3.click('#regen-btn');
  await panel3.waitForFunction((b) => /Gemini 2\.5 Flash · free tier/.test(document.getElementById('step-note').textContent), gb, { timeout: 10000 });
  const gw = (await getLog()).filter(e => /:generateContent/.test(e.path) && !(e.body.tools || []).length && !/single word/.test(JSON.stringify(e.body))).pop();
  check('Gemini writer: same prompt (system rules + <context>)', /gemini-2\.5-flash:generateContent/.test(gw.path) && /Never invent/.test(gw.body.system_instruction.parts[0].text) && /<context>/.test(gw.body.contents[0].parts.slice(-1)[0].text));
  const gmsg = await panel3.inputValue('#message');
  check('Gemini "thought" parts are not in the message', gmsg.startsWith('Hi Priya') && !gmsg.includes('Let me think'), gmsg);
  await panel3.click('#opt-mode [data-value="deep"]');
  check('deep hint says Google search', (await panel3.textContent('#mode-hint')).includes('Gemini searches Google'));
  // A profile with no earlier research, so Deep mode really searches.
  await li.goto('https://www.linkedin.com/in/rahul-real-test/');
  await panel3.waitForFunction(() => document.getElementById('p-name').textContent === 'Rahul Verma', null, { timeout: 8000 });
  await panel3.click('#primary-btn');
  await panel3.waitForFunction(() => document.querySelectorAll('#hooks-list .hook-src').length >= 2, null, { timeout: 15000 });
  const gHooks = await panel3.$$eval('#hooks-list .hook > span', xs => xs.map(x => x.textContent));
  const gr = (await getLog()).filter(e => (e.body.tools || []).some(t => t.google_search)).pop();
  check('Gemini research uses Google Search grounding', !!gr);
  check('only grounded sources kept (made-up domain dropped)', gHooks.some(t => t.includes('techcrunch.com')) && gHooks.some(t => t.includes('pydata.org')) && !gHooks.some(t => t.includes('Forbes')), gHooks);
  await shot('21-gemini', panel3);
  await panel3.click('#opt-mode [data-value="quick"]');
  await panel3.click('#tab-settings');
  await panel3.click('#remove-key');
  await panel3.waitForFunction(() => document.getElementById('mode-chip').textContent === 'Free mode');
  await panel3.click('#tab-compose');

  // ── 13. Dark mode screenshot ─────────────────────────────────────────────
  if (SHOTS) {
    await panel3.click('#tab-settings');
    await panel3.click('#set-theme [data-value="dark"]');
    await shot('10-settings-dark', panel3);
    await panel3.click('#tab-compose');
    await shot('11-compose-dark', panel3);
    await panel3.click('#set-theme [data-value="system"]').catch(() => {});
    await li.goto('https://www.linkedin.com/in/priya-sharma-test/');
    await li.waitForTimeout(800);
    await shot('12-fab', li);
  }

  const fab = await li.evaluate(() => !!document.getElementById('ark-outreach-fab'));
  check('floating button mounted on profile', fab);

  await ctx.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
