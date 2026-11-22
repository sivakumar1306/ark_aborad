# Demo script: LinkedIn Outreach AI (v4.5)

Target length about 8–9 minutes. Line numbers are for commit `3fb653e`. Say things in your own words; the quotes are a guide, not lines to read.

---

## Before you record (10 min)

1. **Get the latest code.** Pull, then check:
   ```bash
   git log --oneline -1
   ```
   It should show `3fb653e`, or later.
2. **Reload the extension.** In `chrome://extensions`, click **↻ reload** on Outreach AI, then reopen the panel. If a yellow "click ↻ reload" banner shows, reload again.
3. **Settings:**
   - Paste your **Gemini key** and click **Test**. The chip should read "AI · Gemini … Flash".
   - **Import my LinkedIn** (common ground needs it).
   - Purpose **Auto**, tone **Neutral**, format **Note**, Research **Quick**. Quick is one request per message, so it's safest on the free tier.
4. **Pick 2 profiles you've tested:**
   - a **student** (shows the purpose warning)
   - a **senior person / founder** with real posts (shows the fact check and the evidence card)

   Press **↻ on the profile card** for each before recording.
5. **In Antigravity, open these tabs in order:**
   - `background.js`
   - `utils/session.js`
   - `content_script.js`
   - `sidepanel.js`
   - `utils/grounding.js`
   - `utils/prompts.js`
   - `utils/gemini.js`
   - `utils/recipient.js`
6. **Have a terminal open** in the repo root.

**If something fails live:** click **Write in free mode** on the error. It always works and is part of the story.

---

## 0:00 Intro (30s)

> "Hi, I'm ___. This is my version of the LinkedIn Outreach AI extension. It reads the profile you're looking at and writes a personalised message.
> AI outreach fails in two ways: it's generic, or it's wrong. And wrong is worse. A made-up 'congrats on your promotion' sent to a stranger, under your name, ends the conversation.
> So I focused on three things: messages that are **checked** before you send them, messages that **fit the person**, and a workflow that **doesn't lose your work**. I tested it on real LinkedIn profiles and fixed what broke."

## 0:30 What existed, and what I found (60s)

> "The original was a popup with Quick and Deep modes, a recent-contacts list and settings. Mid-assignment you shipped v3.1 without the license server: a free template, or Claude with your own key. I built on v3.1."

Pick three problems:
1. **"Clicking the page closed the popup, so a running generation and its result were lost."**
2. **"The free template opened every message with 'I came across your profile and was impressed', ignored LinkedIn's 200-character limit on invite notes, and gave the same text every time."**
3. **"The profile reader broke on real profiles. Posts and About came back empty on LinkedIn's newer layout, a person's own headline was saved as their 'post', and 'Dr. Sheena' was greeted as 'Dear Dr.,'. I fixed each of those, and each fix has a test."**

## 1:30 Live demo (3 min)

1. **Open the panel.** Press **Alt+Shift+O** on the student's profile. *"A side panel, so it stays open and follows me between profiles."*
2. **Recipient chip.** *"It works out who this person is, here a student, from their title."* Set Purpose to **Job opportunity**, and the warning appears. *"A student can't help with roles, so it suggests Networking. I stay in control."* Click **Switch to Networking**.
3. **Common ground.** *"It read my profile and theirs: same school, matched even when one says 'IIT Bombay' and the other the full name."*
4. **Generate** with **Ctrl+Enter**. Point at the line under the button: *"Written by Gemini Flash on the free tier. It also supports Claude: paste either kind of key and it detects which one."*
5. **Fact check: the key moment.** Move to the second profile and generate.
   - *"Every sentence is checked against what was actually read."*
   - Click a **green sentence**: the evidence card shows where it came from.
   - Type a false claim at the end: *"Congrats on your promotion to VP!"*. It turns amber instantly. *"No AI call; this runs on my machine."*
   - Click **Fix with AI**: *"It tells the model exactly which sentence wasn't supported, and the new version is checked again."*
6. **Close and reopen.** Generate, close the panel, reopen it. *"It finished without me; I'll show why in the code."*
7. **Insert.** On LinkedIn click **Connect → Add a note**, then **Insert into LinkedIn**. *"It fills the box but never presses Send. That's deliberate."*
8. **Tracker.** *"Everyone I write to is tracked, with follow-up reminders and CSV export, and a reply-rate hint that's honest about small samples."*
9. **Deep mode, optional, once.** Switch Research to **Deep** and generate.
   - If it works: *"Web hooks, each with its source link; a hook is kept only if its source actually came back from the search."*
   - If it says *"web search skipped (limit)"*: *"The free tier limits web search, so it falls back to hooks from the profile instead of failing."*
10. **Free mode, in one line.** *"With no key at all, it still writes on my device from profile facts only, so it always passes the fact check and fits the limit."*

## 4:30 How it fits together (30s)

> "Four parts:
> - The **content script** runs inside LinkedIn and reads the profile.
> - The **background worker** runs every job: read, research, write.
> - The **side panel** is only a view; it never does work itself.
> - They share state through Chrome storage.
>
> That last decision is why closing the panel is safe."

## 5:00 Code tour (3 min)

Open each file and point at the lines. Explain the idea; don't read the code.

| # | Open | Line | Say |
|---|---|---|---|
| 1 | `background.js` | 94 `runJob` | "Every job runs here, one lock per profile. Errors become a readable state the panel shows." |
| 2 | `background.js` | 110 `keepAlive`, 47 | "Chrome stops idle background workers, so I keep it alive during long AI calls. If it still restarts, the job is marked 'Interrupted' instead of spinning forever." |
| 3 | `utils/session.js` | 52 `update` | "Each profile's progress lives in `chrome.storage.session`. Updates are queued so they never overwrite each other." |
| 4 | `sidepanel.js` | 87 `onStorageChanged` | "The panel just re-draws when storage changes. Close it mid-run, reopen, and it shows the finished result." |
| 5 | `content_script.js` | 82 `loadLazySections` | "LinkedIn loads lower sections only when you scroll. Some layouts scroll the window, some an inner panel, so I bring sections into view and put your scroll back." |
| 6 | `content_script.js` | 117, 130 | "Real profiles have several jobs, like a professor who's also a CEO. I read LinkedIn's 'Current company' and keep all current roles." |
| 7 | `content_script.js` | 314 `hasSubstance` | "Posts like 'Congratulations! 🎉' aren't useful hooks, so a post needs real words." |
| 8 | `content_script.js` | 394, 438 | "LinkedIn's page code ignores text you just assign, so I use the browser's own setter and fire an input event. It fills the box; you press Send." |
| 9 | `utils/grounding.js` | 143, 40, 251, 267 | "Fact check: extract claims (names, numbers, event words like promotion or funding), then look each up in what was read. Claims about *me* are checked only against my own bio." |
| 10 | `sidepanel.js` | 1174, 1240 | "The highlights: an invisible copy of the text sits behind the transparent text box. Clicking a sentence opens its evidence." |
| 11 | `utils/prompts.js` | 12, 50, 150 | "One prompt for both providers: context as JSON in `<context>` tags plus a no-invented-facts rule. For research, a hook is dropped if its source wasn't really returned by the search." |
| 12 | `utils/gemini.js` | 21, 142 | "The key decides the provider. Google retires and overloads models, so I rank the available Flash models and fall back to the next one if the newest is overloaded." |
| 13 | `background.js` | 150 | "Web research is extra: if it hits the free-tier limit, Deep mode continues with profile hooks instead of failing." |
| 14 | `utils/recipient.js` | 33, 76 | "Who is this person? Rules over title and headline. `mismatch` produces the 'they're a student' warning." |

## 8:00 Tests (30s)

```bash
node tests/unit.js
```

> "96 unit tests: the fact check, the free writer across 384 combinations, both API clients' errors and fallbacks. There are also 154 end-to-end checks that load the real extension in Chromium against fake LinkedIn pages and fake Claude and Gemini APIs.
> Every bug I found on real profiles became a test page first, and I checked that the old code fails it."

## 8:30 Trade-offs, process, close (45s)

> "Not built, on purpose: auto-send and bulk messaging, which break LinkedIn's rules, and an AI 'reply probability score', because I prefer checks I can explain over a number I can't back up.
> Limits: the fact check is pattern matching, so it flags things for a human; it doesn't prove truth. LinkedIn changes its page structure often, which is why every profile has 'Review & edit'.
> How I built it: I used AI coding tools heavily. I directed the architecture, tested on real profiles, and turned every bug I found into a test before fixing it.
> Next: have the model cite a source for each claim and compare it with the local check; build an evaluation set of real profiles to tune the prompt.
> Thanks for the fun assignment."

---

## Appendix A: what every file does

| File | Existed? | What it does |
|---|---|---|
| `manifest.json` | Yes, modified | Permissions, side panel, `Alt+Shift+O`, context menu, alarms, notifications. Hosts: `api.anthropic.com`, `generativelanguage.googleapis.com`. |
| `background.js` | Yes, rewritten | Job engine (read → research → write), both providers, free writer, key test, profile import, tracker, reminders. |
| `content_script.js` | Yes, rewritten | Profile reader (both LinkedIn layouts), Insert into LinkedIn, floating "Write outreach" button. |
| `sidepanel.html/js/css` | Replaced the popup | The UI; a pure view over storage. |
| `utils/contacts.js` | Was `cache.js` | Tracker: 50 people, statuses, follow-ups, CSV. |
| `utils/session.js` | New | Per-profile progress in `chrome.storage.session`, with queued updates. |
| `utils/api.js` | New | Claude client: retries, plain-English errors, refusals, cost. |
| `utils/gemini.js` | New | Gemini client: key detection, model ranking and fallback, grounding sources. |
| `utils/prompts.js` | New | Shared writer prompt; research for both providers; drops hooks without a real source. |
| `utils/localwriter.js` | New | Free on-device writer. |
| `utils/formats.js` | New | Note/DM/InMail/Email rules, requirements text, meter, trim. |
| `utils/grounding.js` | New | Fact check. |
| `utils/lint.js` | New | Writing check. |
| `utils/common.js` | New | Common ground (acronym-aware). |
| `utils/recipient.js` | New | Recipient type, Auto purpose, mismatch warning. |
| `utils/names.js` | New | "Dr. Sheena Pravin" → "Sheena" / "Dr. Pravin". |
| `tests/` | New | Unit tests, end-to-end tests, fake Claude + Gemini APIs, fake LinkedIn pages. |

## Appendix B: likely questions and short answers

- **Why does the background worker own the state?** "The side panel can close any time. If it did the work, closing it would kill the job. Making the panel a pure view of storage fixed that, and reopening and multi-tab use work for free."
- **What if Chrome kills the worker mid-request?** "A keep-alive ping during long calls prevents most of it. If it still happens, the restart code marks the job 'Interrupted' so the user can retry."
- **How does the fact check decide what's a claim?** "Capitalised phrases that aren't sentence-start words or people's names, numbers that aren't durations like '15 minutes', and a list of event words. Each is looked up in the sources; a sentence with no claims is neutral."
- **What are its false positives and negatives?** "It can miss a vague false claim and can flag a harmless capitalised word. That's why it says 'check before sending'. Every false alarm I found on real profiles became a test."
- **Why not let the AI fact-check itself?** "It's the same model that might have invented the claim. A deterministic check is independent, instant, free and explainable."
- **Why Gemini as well as Claude?** "Claude needs a paid key; Gemini has a free tier, so anyone can try AI mode. Both share one prompt and the same checks, so the fact check doesn't depend on which model wrote the message."
- **How do you handle the free tier's limits?** "Model fallback when the newest model is overloaded, retries on per-minute limits, a clear message for the daily limit, and Deep mode continues without web search if search is limited. And 'Write in free mode' is always one click away."
- **Why raw `fetch` instead of SDKs?** "The extension ships without a build step, as upstream does. The two small clients add what I'd otherwise get from an SDK: retries, error handling, timeouts."
- **How did you test without paid keys or real LinkedIn?** "Fake Claude and Gemini APIs that return the real response shapes, including errors, plus fake LinkedIn pages built from markup I saw on real profiles."
- **What would you do with more time?** "An evaluation set of real profiles to tune prompts against, claim-level citations from the model, and uploading the resume once instead of with every request."
