# Changelog

## 4.3.0: Evidence on click

- Click any highlighted sentence in the message to see its evidence: the profile field, post or web article it came from (with a link), or exactly which words couldn't be found. The clicked sentence is outlined in the message.
- A one-time hint shows that sentences are clickable.
- Claim labels in the fact check now show clean values (“$40M”, “2026”), not the next word.
- Insights say when the sample is too small to trust (under 20 sent).
- UI: progress steps collapse into a one-line summary once a message is written; options grouped in a card; tighter message box; the common-ground nudge no longer wraps awkwardly; “Neutral” no longer truncated.

## 4.2.0: Built on upstream v3.1 (no license key, no company server)

- **Free mode (default):** a new on-device writer. It uses only profile facts, opens with common ground or their post, fits the 200/300 note limit, and varies between versions. Replaces upstream's fixed "I came across your profile…" template.
- **AI mode:** optional, with the user's own Anthropic API key. Claude Haiku 5.5 by default (Sonnet 5.5 selectable), with a structured prompt and a no-invention rule. The cost is shown after every message.
- **Deep mode in AI mode:** web research with Claude Sonnet 5.5 + `web_search_20260209`. Each hook links its source; hooks whose URL wasn't in the search results are dropped; `pause_turn` is resumed; refusal fallback is enabled.
- **API client:** timeouts, retries for 429/529/5xx honouring `retry-after`, refusal and truncation handling, plain-English errors (bad key, no credit, rate limit, overload).
- "Write in free mode" recovery on any AI error; the key is tested before it's saved; the mode chip replaces the license chip.
- Resume is sent to Claude as a PDF document block (AI mode).
- Fixed: an ended internship at the top of the experience section was treated as the current job.
- Fixed: fact-check false alarms on curly apostrophes and "I’m <name> and I’d…".
- Removed the license key, the quota UI and the Railway server permission; the host permission is now `api.anthropic.com`.

## 4.1.0: Trust layer

- **Fact check:** every sentence's claims (names, numbers, events) are checked against the profile, research, shared background and your own data. Highlights appear inside the message, with sources; re-checks run live while editing.
- **Fix with AI:** revises the draft, listing exactly which claims, clichés and issues to fix.
- **Common ground:** "Import my LinkedIn" reads your profile (and fills in your name and bio). Shared schools (acronym-aware), companies, city and skills become selectable hooks.
- **Writing check:** placeholders, wrong name, clichés, nothing specific, no ask, mostly-about-you, missing subject.
- **Insights:** reply rate and the strongest pattern across how messages were written.
- Every request now includes a "never invent facts" rule.
- Fixed: the panel sometimes missed a profile when the load-complete event raced the URL change.

## 4.0.0

**Workflow**
- Moved the UI from a popup to Chrome's side panel. It stays open, follows you across profiles, and its state survives closing.
- Jobs run in the background worker; progress is stored in `chrome.storage.session`.
- Insert into LinkedIn: fills the invite note or the message composer (and the InMail subject). Never sends.
- Added an in-page "Write outreach" button, a context-menu item and the `Alt+Shift+O` shortcut.

**Messages**
- Formats: connection note (200 free / 300 Premium), DM, InMail, email.
- Live character meter, Trim to fit, Rewrite shorter.
- Deep Mode hooks are selectable; rewriting reuses the research.
- Version history per person; per-person context; editable scraped details.
- Purpose, tone, format and mode are remembered.

**Tracker**
- Up to 50 contacts with status (drafted/sent/replied), search, filters and CSV export.
- Follow-up reminders via notification and toolbar badge.
- v3 "recent contacts" are migrated automatically.

**Reliability**
- One API client: timeouts, retry on network errors and 5xx, safe JSON parsing, readable errors.
- License status is really verified; the header shows the remaining daily quota.
- Deep Mode now sends the user's name and bio.
- Fixed contacts overwriting each other when `profileUrl` was empty.
- New scraper reads list structure, handles grouped roles, drops the India-only location heuristic, and restores scroll position.
- An interrupted job (worker restart) shows a clear error instead of spinning forever.

**Polish**
- First-run setup, dark mode, keyboard shortcuts, toasts, auto-saving settings, ARIA roles and focus states.
- Removed dead code and duplicated or unused CSS.
