# Loom script (target: ~8 minutes)

**Setup before recording**
- Load `linkedin extention/` unpacked. Verify your key once so the header shows "N left today".
- In Settings, click **Import my LinkedIn** (fills name and bio). Pick a target profile you share something with (school, company, city).
- Open two real LinkedIn profiles in tabs: one rich (posts, experience), one sparse.
- Have v3 handy (`git checkout f2a5679 -- "linkedin extention"` in a scratch copy, or just use the screenshots) for the "before" moment.
- Close the side panel. Start on the rich profile.

---

## 0:00 Hook (30s)
> "AI outreach fails in two ways: it's generic, or it's wrong. And wrong is worse. A made-up 'congrats on the promotion' sent to a stranger, under your name, kills the conversation before it starts. So the centrepiece of my upgrade is a trust layer: every claim the AI writes is checked against what's actually on their profile before you send. Around that, I fixed the full loop: **find → write → send → follow up**."

## 0:20 What I found (60s), on the v3 code or screenshots
Pick three. Don't list everything:
1. **Popup closes = work gone.** Deep Mode takes ~20s; click the page and it's lost.
2. **Connection notes are capped at 200 characters on free accounts**, and nothing warned you.
3. **Bugs:** the header said "Active" for any typo'd key; Deep Mode never sent your name or bio; the experience parser used an India-only location regex to decide where jobs ended.

> "None of these need a rebuild. They need the existing pieces arranged around how the user actually works."

## 1:20 Demo: the core loop (2.5 min)
1. Press **Alt+Shift+O**. The side panel opens and has already read the profile. *"It reads the top of the profile instantly; the full read happens on generate."*
2. Open **Review & edit**. *"Bad input is the main reason AI messages feel generic, so you can see and fix what it read."*
3. Choose **Note** and **Deep**, then **Ctrl+Enter**. While research runs, **close the panel**, click around LinkedIn, reopen. *"It finished without me, because jobs now run in the background worker and the panel is just a view of saved state."*
4. **Hooks**: untick one and hit "Write with 2 hooks". *"It doesn't re-run research. I filter the hooks the server already returned and send them back, so no backend change."*
5. Show the **meter**. Switch Settings to Free (200) and show the red bar, then **Trim to fit**. Show versions **‹ 2/3 ›**.
6. On LinkedIn: **Connect → Add a note**, then **Insert into LinkedIn**. *"It fills the box; it never sends. You always press Send. That keeps it on the right side of LinkedIn's automation rules."*
7. Toast → **Mark as sent**.

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
- **`utils/api.js`:** timeouts, a retry on 5xx (Railway returns an HTML 502 on cold starts, which used to show up as a JSON parse error), and errors with codes the UI can act on. For example, an auth error makes the error button take you to Settings.
- **Formats without touching the server:** the format rules go in a short brief appended to the bio the server already sends to the model, plus explicit `format` / `maxChars` fields for when the backend adds support. Then the client enforces the limit anyway.
- **Trust layer:** `utils/grounding.js` extracts claims (names, numbers, event words), looks them up in the sources, and keeps character offsets. The highlights are a mirror div behind a transparent textarea, so you can still edit the message. `utils/common.js` does fuzzy org matching with acronyms; `utils/lint.js` handles writing rules. 36 unit tests, including "a fully true message raises zero alarms".
- **Scraper:** reads LinkedIn's list structure first, falls back to text, and handles the SPA swapping pages before the DOM updates.
- **Tests:** `node tests/e2e.js` loads the real extension in Chromium against fixture pages and a mock API: 78 checks, including closing the panel mid-run, a simulated 502, and a simulated hallucination that gets caught and fixed. Run it on camera (~40s).
- Be straightforward about your process. If you used AI coding tools, say how you directed and verified them. For an AI product role, that's a strength.

## 7:05 Trade-offs and what's next (60s)
- **Not done on purpose:** auto-sending or bulk messaging. It's against LinkedIn's terms and gets accounts restricted.
- **Next with backend access:** read `format` / `maxChars` natively; cache the resume server-side instead of sending it with every request; return `remaining` from quick mode too.
- **Next on the trust layer:** with backend access, have the writer cite the source for each claim it makes, so checking becomes exact matching instead of heuristics.
- **Next on the client:** a template library; insights per hook type once there's enough reply data.

## 8:05 Close (15s)
> "Same product, same API, same keys. It covers the whole loop from profile to follow-up, and every message is checked before it goes out under your name. Thanks for the fun assignment."
