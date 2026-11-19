# Loom script (target: 7–8 minutes)

**Setup before recording**
- Load `linkedin extention/` unpacked. Verify your key once so the header shows "N left today".
- Fill in your name and bio in Settings.
- Open two real LinkedIn profiles in tabs: one rich (posts, experience), one sparse.
- Have v3 handy (`git checkout f2a5679 -- "linkedin extention"` in a scratch copy, or just use the screenshots) for the "before" moment.
- Close the side panel. Start on the rich profile.

---

## 0:00 Hook (20s)
> "The extension writes good messages. But I watched where people actually lose time: the popup forgets everything, the message doesn't fit LinkedIn's limits, and once you hit copy, nothing helps you send it or follow up. So I focused on the full loop: **find → write → send → follow up**."

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

## 3:50 Demo: follow-up (45s)
- **Tracker** tab: status, search, filters. *"Writing is half the job; most replies come from the follow-up."* Show the reminder setting and CSV export.
- Navigate to the second profile. The panel follows on its own; the old message is kept per person.

## 4:35 How it's built (1.5 min), open the code
- **Architecture:** `background.js` owns every job and all state writes (`utils/session.js` → `chrome.storage.session`); `sidepanel.js` only re-renders on `storage.onChanged`. *"That one decision fixed persistence, multi-tab use, and let me add the side panel without duplicating logic."*
- **`utils/api.js`:** timeouts, a retry on 5xx (Railway returns an HTML 502 on cold starts, which used to show up as a JSON parse error), and errors with codes the UI can act on. For example, an auth error makes the error button take you to Settings.
- **Formats without touching the server:** the format rules go in a short brief appended to the bio the server already sends to the model, plus explicit `format` / `maxChars` fields for when the backend adds support. Then the client enforces the limit anyway.
- **Scraper:** reads LinkedIn's list structure first, falls back to text, and handles the SPA swapping pages before the DOM updates.
- **Tests:** `node tests/e2e.js` loads the real extension in Chromium against fixture pages and a mock API: 52 checks, including closing the panel mid-run and a simulated 502. Run it on camera (~40s).
- Be straightforward about your process. If you used AI coding tools, say how you directed and verified them. For an AI product role, that's a strength.

## 6:05 Trade-offs and what's next (60s)
- **Not done on purpose:** auto-sending or bulk messaging. It's against LinkedIn's terms and gets accounts restricted.
- **Next with backend access:** read `format` / `maxChars` natively; cache the resume server-side instead of sending it with every request; return `remaining` from quick mode too.
- **Next on the client:** a template library, A/B tracking of which hooks get replies (each message version already records which hooks it used).

## 7:05 Close (15s)
> "Same product, same API, same keys. It now covers the whole loop from profile to follow-up, and it doesn't lose your work. Thanks for the fun assignment."
