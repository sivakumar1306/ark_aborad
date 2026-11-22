# Demo script: LinkedIn Outreach AI (v4.4)

Target length about 9 minutes. Line numbers are for commit `f2ae881`. Say things in your own words; the quotes are a guide, not lines to read.

---

## Before you record (10 min)

1. Pull the latest code, run `git log --oneline -1` and check it shows `f2ae881`.
2. In `chrome://extensions`, click **↻ reload** on the extension.
3. Pick 2 profiles you've already tested: one **student**, and one **senior engineer / founder** with real posts.
4. **Settings:**
   - **Import my LinkedIn**, so common ground works.
   - Paste your API key and click **Test** (AI mode). A free Gemini key from aistudio.google.com works; so does an Anthropic key.
   - Purpose **Auto**, tone **Neutral**, format **Note**.
5. On each profile, press **↻** on the profile card once, so the full read is done before recording.
6. In Antigravity, open these files in tabs, in this order:
   - `background.js`
   - `utils/session.js`
   - `content_script.js`
   - `sidepanel.js`
   - `utils/grounding.js`
   - `utils/prompts.js`
   - `utils/recipient.js`
7. Have a terminal ready in the repo root for `node tests/unit.js`.

---

## 0:00 Intro (30s)

> "Hi, I'm ___. This is my take on the LinkedIn Outreach AI extension. It reads the profile you're looking at and writes a personalised message.
> AI outreach fails in two ways: it's generic, or it's wrong. And wrong is worse. A made-up 'congrats on your promotion' sent to a stranger under your name ends the conversation.
> So I focused on three things: messages that are **checked** before you send them, messages that **fit the person**, and a workflow that **doesn't lose your work**. And I tested everything on real profiles."

## 0:30 What existed, and what I found (60s)

Show the original popup briefly (screenshot or the first commit), or just describe it.

> "The original had a popup with Quick and Deep modes, a recent-contacts list and settings. Mid-assignment you shipped v3.1 without the license server: a free template, or Claude with the user's own key. I built on v3.1."

Pick three problems:
1. **"Clicking the page closed the popup, so a running generation and the result were lost."**
2. **"The free template opened every message with 'I came across your profile and was impressed', ignored LinkedIn's 200-character limit on invite notes, and gave the same text every time."**
3. **"The AI path used `max_tokens: 400` on a model that thinks before answering, so replies could come back cut off, and there were no retries. The profile reader also relied on an India-only city list to split jobs, and broke on LinkedIn's newer layout."**

## 1:30 Live demo (3 min)

1. **Open the panel.** Press **Alt+Shift+O** on a profile. *"It's a side panel now, so it stays open and follows me between profiles."*
2. **Recipient chip.** *"It works out who this person is, here a student, from their title. Auto picks the right purpose."* Switch Purpose to **Job opportunity**: the warning appears. *"A student can't help with roles, so it suggests Networking. I stay in control."* Click **Switch to Networking**.
3. **Common ground.** *"It read my profile and theirs: same school, matched even though one says 'IIT Bombay' and the other the full name."*
4. **Generate** with **Ctrl+Enter**. Point at the summary line: *"Written in 2 seconds by Gemini Flash on the free tier"* (or *"by Claude Haiku, under a tenth of a cent"* with an Anthropic key). *"Paste either kind of key; it detects which one."*
5. **Fact check: the key moment.** *"Every sentence is checked against what was actually read."* Click a green sentence: the evidence card shows where it came from. Then type a false claim at the end, e.g. *"Congrats on your promotion to VP!"*. It turns amber instantly. *"No AI call; this runs on my machine."* Click **Fix with AI**. *"It tells Claude exactly which sentence wasn't supported, and the new version is checked again."*
6. **Deep mode** on the second profile: *"Claude Sonnet searches the web. Every hook links its source, and a hook is kept only if its link actually came back from the search."* Untick a hook and rewrite: *"No new search; it reuses the results."*
7. **Close and reopen.** Start a Deep run, close the panel, reopen it. *"It finished without me; I'll show why in the code."*
8. **Insert.** Click **Connect → Add a note** on LinkedIn, then **Insert into LinkedIn**. *"It fills the box but never presses Send. That's deliberate."*
9. **Tracker.** *"Everyone I write to is tracked, with follow-up reminders and CSV export, plus a reply-rate hint that's honest about small samples."*
10. **Free mode,** in one line: *"Without a key, it still writes on my device from profile facts only, so it always passes the fact check and fits the limit."*

## 4:30 How it fits together (30s)

Say this before opening code:

> "Four parts:
> - The **content script** runs inside LinkedIn and reads the profile.
> - The **background worker** runs every job: read, research, write.
> - The **side panel** is only a view; it never does work itself.
> - They share state through Chrome storage.
>
> That last decision is what makes closing the panel safe."

## 5:00 Code tour (3 min)

Open each file and point at the lines. Don't read the code; explain the idea.

| # | Open | Lines | Say |
|---|---|---|---|
| 1 | `background.js` | 89–104 `runJob` | "Every job runs here, with a lock per profile so two can't collide. Errors become a readable state the panel shows." |
| 2 | `background.js` | 105 `keepAlive` | "Chrome stops idle background workers, so during a long Claude call I ping it to keep it alive. If it still restarts, line 43 marks the job 'Interrupted' instead of spinning forever." |
| 3 | `utils/session.js` | 52 `update` | "Each profile's progress is saved in `chrome.storage.session`. Updates are queued so they never overwrite each other." |
| 4 | `sidepanel.js` | 85 `onStorageChanged` | "The panel just re-draws when storage changes. Close it mid-run, reopen, and it reads the finished state." |
| 5 | `content_script.js` | 82 `loadLazySections` | "LinkedIn only loads lower sections as you scroll. Some layouts scroll the window, others an inner panel, so I bring sections into view and put your scroll position back." |
| 6 | `content_script.js` | 44 + 46 `scrape` | "LinkedIn changes the URL before the page content, so I wait until the name changes; otherwise you'd read the previous person." |
| 7 | `content_script.js` | 117 `topCardCompany`, 130 `headlineRoles` | "Found on real profiles: people with several jobs, like a professor who's also a CEO. I read LinkedIn's 'Current company' in the header and keep all current roles." |
| 8 | `content_script.js` | 394 `insertMessage`, 438 `setNativeValue` | "LinkedIn's page code ignores text you just assign, so I set the value through the browser's own setter and fire an input event. It fills the box; you press Send." |
| 9 | `utils/grounding.js` | 143 `extractClaims`, 40 `EVENTS`, 251 `check` | "Fact check: pull out claims (names, numbers, event words like promotion or funding), then look each one up in what was read. Claims about *me* (line 267) are only checked against my own bio." |
| 10 | `sidepanel.js` | 1140 `renderBackdrop` | "The highlights inside the message: an invisible copy of the text sits behind the transparent text box and gets painted, so you can still type." |
| 11 | `utils/api.js` | 44 `create`, 91 `classify`, 120 `textOf` | "The Claude client: timeouts, retries on overload that respect retry-after, refusals and cut-off replies handled, and errors in plain English. Any failure offers 'Write in free mode'." |
| 11b | `utils/gemini.js` | `pickModel`, `sourcesOf` | "Gemini as a second provider, since Claude needs a paid key. Google retires models often, so on Test I ask which models the key can use and pick the newest Flash. For research I keep only hooks whose domain Gemini actually grounded on." |
| 12 | `utils/prompts.js` | 12 `WRITER_SYSTEM`, 109 `research`, 143 | "Context goes to Claude as JSON inside `<context>` tags, with a no-invented-facts rule. For research: web search on Sonnet, and line 143 drops any hook whose link didn't actually come back from the search." |
| 13 | `utils/recipient.js` | 33 `RULES`, 76 `mismatch` | "Who is this person? Rules over their title and headline. The mismatch function produces the 'they're a student' warning." |
| 14 | `utils/localwriter.js` | 109 `ASK_BY_TYPE` | "Free mode: the same purpose gets a different ask depending on who they are." |

## 8:00 Tests (30s)

Run in the terminal:

```bash
node tests/unit.js
```

> "83 unit tests. For example, the free writer is checked across 384 combinations: always within LinkedIn's limit, no clichés, nothing unbacked. There are also 140 end-to-end checks that load the real extension in Chromium, against fake LinkedIn pages and a fake Claude API."

Then:
> "Every bug I found on real profiles became a test page first, and I confirmed the old code fails on it: posts with nested hashtags, the newer layout, the inner-panel scrolling, 'Dear Dr.'."

## 8:30 Trade-offs, process, close (45s)

> "Things I chose not to do: no auto-send and no bulk messaging, because it's against LinkedIn's rules and gets accounts restricted. And no AI 'reply probability score': I prefer checks I can explain over a number I can't back up.
> Limits: the fact check is pattern-matching, so it flags things for a human; it doesn't prove truth. LinkedIn changes its page structure often, which is why every profile has 'Review & edit'.
> How I built it: I used AI coding tools heavily. I directed the architecture, tested on real profiles, and turned every bug I found into a test before fixing it.
> Next steps: have Claude cite a source for each claim and compare it against the local check; upload the resume once instead of with every request; build an evaluation set of real profiles to tune the prompt.
> Thanks for the fun assignment."

---

## Appendix A: what every file does

| File | Existed? | What it does |
|---|---|---|
| `manifest.json` | Yes, modified | Permissions, side panel, the `Alt+Shift+O` command, context menu, alarms, notifications. The only host is `api.anthropic.com`. |
| `background.js` | Yes, rewritten | Job engine (read → research → write), both writers, key test, profile import, tracker writes, follow-up reminders. |
| `content_script.js` | Yes, rewritten | Profile reader, Insert into LinkedIn, the floating "Write outreach" button. |
| `sidepanel.html/js/css` | Replaced the popup | The UI; a pure view over storage. |
| `utils/contacts.js` | Was `cache.js` | Tracker: 50 people, statuses, follow-ups, CSV; migrates old contacts. |
| `utils/session.js` | New | Per-profile progress in `chrome.storage.session`, with queued updates. |
| `utils/api.js` | New | Claude Messages API client. |
| `utils/prompts.js` | New | Writer and research prompts; keeps only hooks with real sources. |
| `utils/localwriter.js` | New | Free on-device writer. |
| `utils/formats.js` | New | Note/DM/InMail/Email rules, the requirements text, meter, trim. |
| `utils/grounding.js` | New | Fact check. |
| `utils/lint.js` | New | Writing check: clichés, placeholders, wrong name, no ask… |
| `utils/common.js` | New | Common ground, including acronym matching. |
| `utils/recipient.js` | New | Recipient type, Auto purpose, mismatch warning. |
| `utils/names.js` | New | "Dr. Sheena Pravin" → "Sheena" / "Dr. Pravin". |
| `tests/` | New | Unit tests, end-to-end tests, fake Claude API, fake LinkedIn pages. |

## Appendix B: likely questions and short answers

- **Why does the background worker own the state?** "The side panel can close at any moment. If it did the work, closing it would kill the job. Making the panel a pure view of storage fixed that, and made multi-tab and reopen work for free."
- **What if Chrome kills the worker mid-request?** "The keep-alive ping during long calls prevents most of it. If it still happens, the restart code marks the job 'Interrupted' so the user can retry, instead of seeing a spinner forever."
- **How does the fact check decide what's a claim?** "Capitalised phrases that aren't sentence-start words or the people's names, numbers that aren't durations like '15 minutes', and a list of event words. Each is looked up in the sources. Without any claims, a sentence is neutral."
- **What are its false positives and negatives?** "It can miss a vague false claim ('your amazing growth') and can flag a harmless capitalised word. That's why it says 'check before sending'. I fixed every false alarm I found on real profiles and added a test for it."
- **Why not let Claude fact-check itself?** "It's the same model that might have made the claim up. An independent, deterministic check is cheaper, instant and explainable. Next, I'd have Claude cite sources and compare the two."
- **Why Haiku for writing and Sonnet for research?** "Haiku was upstream's choice and it's cheap. The web search tool version I use isn't listed for Haiku, so research runs on Sonnet."
- **Why add Gemini?** "Claude needs a paid key; Gemini has a free tier, so anyone can try AI mode. Both providers share one prompt (`writerPrompt`) and the same checks, so the fact check doesn't depend on which model wrote the message."
- **Why raw `fetch` instead of the SDK?** "The extension ships without a build step, as upstream does. The SDK would need a bundler. The client wraps what I'd otherwise get from the SDK: retries, errors, timeouts."
- **How do you stop made-up sources?** "Research returns hooks with URLs; I keep a hook only if its URL appeared in the actual search results (`prompts.js` line 143)."
- **How did you test without a key or real LinkedIn?** "A fake Claude API that returns the real response shapes (thinking blocks, web search results, `pause_turn`, overload errors), and fake LinkedIn pages built from real markup I saw while testing."
- **What would you do with more time?** "An evaluation set of real profiles to tune prompts against, uploading the resume once instead of with every request, and claim-level citations from Claude."
