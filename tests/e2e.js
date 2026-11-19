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
const KEY      = 'ARK-TEST-0000-0001';
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
  fs.writeFileSync(apiPath, fs.readFileSync(apiPath, 'utf8').replace(/const SERVER_URL = '[^']+'/, `const SERVER_URL = '${MOCK}'`));
  const mPath = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  m.host_permissions.push(`${MOCK}/*`);
  fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
  return dir;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    const file = /\/in\/alex/.test(url) ? 'profile-modern.html' : /\/in\//.test(url) ? 'profile-classic.html' : null;
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
  await shot('01-onboarding');
  await panel.fill('#ob-key', 'ARK-WRONG-KEY');
  await panel.click('#ob-verify');
  await panel.waitForSelector('#ob-key-status[data-status="invalid"]');
  check('invalid key rejected with server reason', (await panel.textContent('#ob-key-status')).includes('not recognised'));
  await panel.fill('#ob-key', KEY.toLowerCase());
  await panel.click('#ob-verify');
  await panel.waitForSelector('#ob-key-status[data-status="valid"]');
  check('valid key accepted, shows remaining', (await panel.textContent('#ob-key-status')).includes('20 messages left'));
  await panel.waitForSelector('[data-ob="2"]:not(.hidden)');
  await panel.fill('#ob-name', 'Sam Rivera');
  await panel.fill('#ob-bio', 'Final-year CS student into ML infra.');
  await panel.click('#ob-next');
  await panel.click('#ob-done');
  await panel.waitForSelector('#onboarding.hidden', { state: 'attached' });
  check('quota chip reflects license', (await panel.textContent('#quota-chip')).includes('20 left'));

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

  let log = await (await fetch(`${MOCK}/__log`)).json();
  const q = log.filter(l => l.path === '/api/generate/quick').pop().body;
  check('quick request sends format + brief', q.format === 'note' && /HARD LIMIT/.test(q.userBio) && q.userName === 'Sam Rivera', q);
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
  const hookCount = await panel3.locator('#hooks-list .hook').count();
  check('hooks shown with checkboxes', hookCount === 4, hookCount);
  check('first 3 hooks preselected', (await panel3.locator('#hooks-list input:checked').count()) === 3);
  await shot('05-deep-hooks', panel3);
  await panel3.locator('#hooks-list input').nth(0).uncheck();
  await panel3.waitForFunction(() => /Write with 2 hooks/.test(document.getElementById('primary-label').textContent));
  check('button reflects hook selection', true);
  await panel3.click('#primary-btn');
  await panel3.waitForFunction(() => document.getElementById('v-label').textContent.trim() === '3 / 3', null, { timeout: 15000 });
  log = await (await fetch(`${MOCK}/__log`)).json();
  const d = log.filter(l => l.path === '/api/generate/deep').pop().body;
  check('only selected hooks sent to writer', d.enrichmentJSON.topHooks.length === 2 && !d.enrichmentJSON.topHooks[0].includes('Series B'), d.enrichmentJSON.topHooks);
  check('deep request now includes your name + bio', d.userName === 'Sam Rivera' && d.userBio.includes('Final-year'), d.userName);
  check('enrich did not re-run for rewrite', log.filter(l => l.path === '/api/generate/enrich').length === 1);
  await panel3.click('#v-prev');
  check('version navigation', (await panel3.textContent('#v-label')).trim() === '2 / 3');

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
  await panel3.waitForFunction(() => document.getElementById('p-name').textContent === 'Alex Chen', null, { timeout: 8000 });
  check('panel follows navigation', true);
  check('message area reset for new person', await panel3.locator('#result.hidden').count() === 1);
  await panel3.click('#opt-format [data-value="inmail"]');
  await panel3.click('#primary-btn');
  await panel3.waitForSelector('#result:not(.hidden)', { timeout: 15000 });
  const s2 = await sw.evaluate(() => Sessions.get('alex-chen-test'));
  check('fallback parser: title/company', s2.profile.experienceEntries[0]?.title === 'Product Designer' && s2.profile.currentCompany === 'Northwind', s2.profile.experienceEntries);
  check('fallback parser: second role not polluted by location', s2.profile.experienceEntries[1]?.title === 'UX Designer' && s2.profile.experienceEntries[1]?.company === 'Shopify', s2.profile.experienceEntries);
  check('headline + location', s2.profile.headline.includes('Product Designer @ Northwind') && s2.profile.location === 'Toronto, Ontario, Canada', [s2.profile.headline, s2.profile.location]);
  check('InMail shows subject + body meter', (await panel3.inputValue('#message')).startsWith('Subject:') && (await panel3.textContent('#meter-text')).includes('/ 1900'));

  // ── 10. Errors ───────────────────────────────────────────────────────────
  console.log('\nErrors');
  await panel3.evaluate(() => { document.getElementById('context-box').open = true; });
  await panel3.fill('#opt-context', 'FLAKY');
  await sleep(500);
  await panel3.click('#regen-btn');
  await panel3.waitForFunction(() => document.getElementById('v-label').textContent.trim() === '2 / 2', null, { timeout: 20000 });
  check('HTML 502 is retried transparently', true);
  await sw.evaluate(() => chrome.storage.local.set({ licenseKey: 'ARK-REVOKED-KEY' }));
  await sleep(200);
  await panel3.click('#regen-btn');
  await panel3.waitForSelector('#error-banner:not(.hidden)', { timeout: 10000 });
  check('auth error shown in plain words', (await panel3.textContent('#error-text')).includes('Invalid license key'));
  check('error action routes to Settings', (await panel3.textContent('#error-action')) === 'Open Settings');
  check('chip flips to invalid', (await panel3.textContent('#quota-chip')).includes('invalid') || (await panel3.textContent('#quota-chip')).includes('saved'));
  await shot('09-error', panel3);
  await sw.evaluate((k) => chrome.storage.local.set({ licenseKey: k }), KEY);

  // ── 11. Dark mode screenshot ─────────────────────────────────────────────
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
