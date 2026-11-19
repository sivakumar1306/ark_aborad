# Loom script (target: ~8 minutes)

**Setup before recording**
- Load `linkedin extention/` unpacked.
- Get an Anthropic API key (console.anthropic.com, a few dollars of credit is plenty) so you can demo AI mode and web research. Paste it in Settings → **Test**. The header should show "AI · Haiku 5.5".
- In Settings, click **Import my LinkedIn** (fills name and bio). Pick a target profile you share something with (school, company, city).
- Open two real LinkedIn profiles in tabs: one rich (posts, experience), one sparse.
- Have v3 handy (`git checkout f2a5679 -- "linkedin extention"` in a scratch copy, or just use the screenshots) for the "before" moment.
- Close the side panel. Start on the rich profile.

---

## 0:00 Hook (30s)
> "AI outreach fails in two ways: it's generic, or it's wrong. And wrong is worse. A made-up 'congrats on the promotion' sent to a stranger, under your name, kills the conversation before it starts. So the centrepiece of my upgrade is a trust layer: every claim the AI writes is checked against what's actually on their profile before you send. Around that, I fixed the full loop: **find → write → send → follow up**."

## 0:20 What I found (60s), on the v3.1 code or screenshots
Pick three. Don't list everything:
1. **Popup closes = work gone.** Click the page and the result is lost.
2. **The free template opens with "I came across your profile and was impressed…"** every time, and ignores that connection notes are capped at **200 characters** on free accounts.
3. **The AI path was fragile:** `max_tokens: 400` on a model that thinks by default (replies can come back cut off or empty), no retries, no handling of refusals or overload. And the scraper's experience parser used an India-only location regex.

> Optional but worth 15s: *"Mid-assignment you shipped v3.1 without the license server. I rebased onto it the same day: kept free mode as the default, made AI mode use the user's own key properly, and brought back real web research for Deep mode."* It shows you adapt fast.

> "None of these need a rebuild. They need the existing pieces arranged around how the user actually works."

## 1:20 Demo: the core loop (2.5 min)
1. Press **Alt+Shift+O**. The side panel opens and has already read the profile. *"It reads the top of the profile instantly; the full read happens on generate."*
2. Point at the chip: **Free mode** vs **AI · Haiku 5.5**. Generate once in free mode first: *"No key, no network call, and it still opens with something specific and fits the 200-character limit."* Then switch to your key.
3. Open **Review & edit**. *"Bad input is the main reason AI messages feel generic, so you can see and fix what it read."*
4. Choose **Note** and **Deep**, then **Ctrl+Enter**. While research runs, **close the panel**, click around LinkedIn, reopen. *"It finished without me, because jobs now run in the background worker and the panel is just a view of saved state."*
5. **Hooks**: each web hook links its source (techcrunch, pydata…). *"Claude Sonnet 5.5 searched the web; I only keep a hook if its URL actually came back from the search, so a made-up source can't get through."* Untick one and hit "Write with 2 hooks"; research doesn't re-run. Point at the cost line: *"Every message shows what it cost: about two hundredths of a cent on Haiku."*
6. Show the **meter**. Switch Settings to Free (200) and show the red bar, then **Trim to fit**. Show versions **‹ 2/3 ›**.
7. On LinkedIn: **Connect → Add a note**, then **Insert into LinkedIn**. *"It fills the box; it never sends. You always press Send. That keeps it on the right side of LinkedIn's automation rules."*
8. Toast → **Mark as sent**.

## 3:20 Demo: the trust layer (1.5 min). This is the moment, so slow down
1. Point at **✦ Common ground**: *"It read my profile and theirs. We both went to the same school, and it matched 'IIT Bombay' against 'Indian Institute of Technology Bombay'. That's the best opener in cold outreach, and it costs nothing."* Generate; the message opens with it.
2. Open the **check** under the message: green highlights, each with its source. *"Every claim is backed by something it actually read."*
3. Type a false claim into the message live, e.g. *"Congrats on your promotion to VP!"*. It turns amber instantly, with "Couldn't find 'VP' or 'promotion'". *"No AI call. This runs locally, so it's instant and free."*
4. Click **✦ Fix with AI**. *"It tells the model exactly which sentence was unsupported, plus any clichés, and checks the result again."* The check goes green.
5. Be upfront: *"It's a heuristic. It flags, it doesn't judge truth, which is why the label says 'check before sending'."*

## 4:50 Demo: follow-up and insights (45s)
- **Tracker** tab: status, search, filters. *"Writing is half the job; most replies come from the follow-up."* Show the reminder setting and CSV export.
- **Insights**: *"Every message records how it was written, so once you mark replies, it tells you what works, like whether common-ground openers get more replies."* (With few real replies yet, say it's built to learn as you use it.)
- Navigate to the second profile. The panel follows on its own; the old message is kept per person.

## 5:35 How it's built (1.5 min), open the code
- **Architecture:** `background.js` owns every job and all state writes (`utils/session.js` → `chrome.storage.session`); `sidepanel.js` only re-renders on `storage.onChanged`. *"That one decision fixed persistence, multi-tab use, and let me add the side panel without duplicating logic."*
- **`utils/api.js`:** the Claude client. Timeouts; retries for 429/529/5xx that respect `retry-after`; refusal and truncated-reply handling; errors with codes the UI acts on (bad key → Settings, plus a "Write in free mode" button for any AI failure); cost from `usage`.
- **`utils/prompts.js`:** the context goes to Claude as JSON inside `<context>` tags and the hard rules in `<requirements>`; the system prompt forbids invented facts. Research uses the web search server tool and resumes `pause_turn`.
- **`utils/localwriter.js`:** the free writer. Unit-tested across 384 combinations: always within LinkedIn's limits, no clichés, zero unverified claims.
- **Trust layer:** `utils/grounding.js` extracts claims (names, numbers, event words), looks them up in the sources, and keeps character offsets. The highlights are a mirror div behind a transparent textarea, so you can still edit the message. `utils/common.js` does fuzzy org matching with acronyms; `utils/lint.js` handles writing rules. 36 unit tests, including "a fully true message raises zero alarms".
- **Scraper:** reads LinkedIn's list structure first, falls back to text, and handles the SPA swapping pages before the DOM updates.
- **Tests:** `node tests/e2e.js` loads the real extension in Chromium against fixture pages and a mock of the Anthropic API: 106 checks, including closing the panel mid-run, a 529 overload retry, a fabricated source URL being dropped, and a simulated hallucination that gets caught and fixed. Plus 59 unit tests. Run it on camera (~40s).
- Be straightforward about your process. If you used AI coding tools, say how you directed and verified them. For an AI product role, that's a strength.

## 7:05 Trade-offs and what's next (60s)
- **Not done on purpose:** auto-sending or bulk messaging. It's against LinkedIn's terms and gets accounts restricted.
- **Next:** prompt caching once the shared prompt is long enough to cache; upload the resume once via the Files API instead of sending it with every request; an eval set of real profiles to tune the writer prompt against.
- **Next on the trust layer:** have Claude cite the source for each claim it writes, then compare that against the local check, so the two checks back each other up.
- **Next on the client:** a template library; insights per hook type once there's enough reply data.

## 8:05 Close (15s)
> "Built on your latest version: free by default, Claude when you bring a key. It covers the whole loop from profile to follow-up, and every message is checked before it goes out under your name. Thanks for the fun assignment."
