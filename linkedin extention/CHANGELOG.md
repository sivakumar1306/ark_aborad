# Changelog

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
