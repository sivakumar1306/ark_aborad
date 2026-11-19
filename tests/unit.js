'use strict';
// Unit tests for the local "trust layer": fact check, common ground, writing lint.
//   node tests/unit.js

const path = require('path');
const ext = (f) => path.join(__dirname, '..', 'linkedin extention', 'utils', f);
const Grounding = require(ext('grounding.js'));
const CommonGround = require(ext('common.js'));
const Lint = require(ext('lint.js'));

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
