# ClassRec — session handoff

Written 2026-07-29. Everything below is verified against the repo, not remembered.

## Where the code is

- **Branch:** `feature/live-doubt-flags`, one commit ahead of `main` (`86098fe`).
- **`main`** is merged, pushed, and tagged **`v1.2.0`** ("Feature 1 — voice picker + My Lectures").
- **Python env:** conda **`RecEnv`** → `/Users/inishbista/miniconda3/envs/RecEnv/bin/python`.
  Run the app with `python -m uvicorn main:app --reload --port 8000` from `src/`.
- **DB:** SQLite at `data/classrec.db`, Alembic head `c7a3e91b45f2`, already applied.

### Uncommitted work in the tree

| File | What changed |
|---|---|
| `static/js/audio-playback.js` | Playback highlight rewritten — word index + cursor + binary search (see below) |
| `static/js/doubt-panel.js` / `.css` | Doubt panel: icon states, popup, press-and-hold selection |
| `static/js/save-transcript.js` | Persists word timestamps and flags; dispatches `transcript:discarded` |
| `static/js/live.js` | Resets transcript on discard as well as save |
| `static/js/lectures.js`, `templates/lectures.html`, `static/css/lectures.css` | Flags shown in My Lectures — **unapproved design, Inish objected to the doubt count on the card. Decide keep or revert.** |
| `src/main.py` | Flag count on `GET /sessions` (part of the same unapproved change) |

## What was built this session

**Live doubt flags** (committed in `86098fe` plus the uncommitted refinements):
Press and hold on a word in the live transcript for 400ms, drag to sweep a range
(purple), release. The floating icon top-right arms with a spinning halo but the
panel does **not** open — it only opens on click, as a popup. Inside, the selection
is pinned as a chip; "Ask" hits `POST /ask`, "⚑ Flag only" saves the moment without a
question. Flags ride along with the transcript on save and come back from
`GET /sessions/{id}`.

- `POST /ask` is **stubbed** — returns a placeholder string. There is **no LLM anywhere
  in this project**. Swapping in a real model means replacing the body of `ask_route`
  in `src/main.py`; the request shape (quote + context + question + timestamps) is
  already what a model call needs.
- Colour meanings on `span.word`: **green** = audio playback, **purple** = being
  selected, **amber** = flagged.

**Playback performance fix** (`audio-playback.js`): the sync loop used to run
`querySelectorAll('span.word')` and touch every span 60×/sec. Replaced with two
`Float64Array`s plus a remembered cursor; binary search only on seek. Verified against
the old implementation over 191,991 simulated frames — 0.042 walk steps/frame vs 8,000,
2 mismatches, both exact word-boundary tie-breaks that resolve on the next frame.
125 KB of index for an 8,000-word lecture.

## The open question: frontend redesign

**Inish's instruction:** do the **live page first**, leave the homepage. **Colour is
deferred** — layout and animation must survive a later retheme, so every colour goes
through a token from day one. Build separate files rather than editing in place.

**Reference:** Audionotes.app / Coconote — light ground, orange accent, marketing-led,
mobile-first. ClassRec today is the opposite (dark `#0d0d11`, amber `#e8a020`).

**Still undecided, and blocking:**

1. **Stack** — Jinja + new stylesheets in place, vs React in a separate repo.
   Context that matters: the roadmap implies flashcards, quizzes, study sets, folders,
   sharing — ten-plus pages, which argues for React. The audio/WebSocket code does
   **not** need porting into React; it is plain JS that can run alongside it. That makes
   the React cost lower than first estimated.
2. **Scope** — live only, live + lectures, or all four pages.

**The Notion inspiration doc has never been read.** `notion.site` serves a JavaScript
shell and returns nothing. To use it: Notion `⋯ → Export → Markdown & CSV`, unzip, and
give the path. Everything currently known about the reference comes from two screenshots.

Existing plan file: `/Users/inishbista/.claude/plans/https-difficult-sousaphone-cf5-notion-si-enchanted-candle.md`

## Constraints any redesign must respect

Verified by a full frontend inventory (4 templates, 6 CSS files / 1,948 lines, 9 JS
files / 2,729 lines):

1. **`span.word[data-start][data-end]` inside `#transcriptContent` is load-bearing
   data, not decoration.** It is read by `save-transcript.js` (`currentWords`),
   `audio-playback.js` (playback sync), `doubt-panel.js` (`paintRange`,
   `commitSelection`, `contextAround`) and `lectures.js`. Restyle freely; changing the
   structure breaks save, playback and doubts at once.
2. **`auth.js:293–345` holds a second, unsynchronised copy of the whole palette** as a
   JS object for Clerk's theme, plus ~200 lines of inline-styled HTML. A retheme is not
   finished until that moves too.
3. **`asset_version` is missing from 5 asset URLs** — `index.css`, `upload.css`,
   `upload.js`, `tracker.js`, `auth.js`. Fix before redesigning or stale CSS will be
   debugged as phantom bugs.
4. `templates/live.html` has an **unclosed `.overlay` div**; the five `<script>` tags
   end up nested inside it.
5. `live.css:2` sets `overflow:hidden` on `body` and `live.css:33` pins `.container` to
   `calc(100vh - 220px)` — both block mobile.
6. Dead code worth deleting: empty `static/css/style.css.py`, unused `.card` /
   `.status-badge` in `base.html`, dead `.result-meta` / `.error-text` /
   `.success-label` in `upload.css:127–173`, and `#summaryBtn` / `#summaryPanel` which
   have ~75 lines of CSS and no JS behind them.

## Known issues not yet addressed

- **`src/main.py:44` — `_pipeline_semaphore = asyncio.Semaphore(1)`.** One audio chunk
  processed at a time server-wide, not per user. This is the real scaling ceiling.
- **`repository.py:23` — `MAX_SESSIONS_PER_USER = 7`.** Every save evicts everything
  past the newest 7, and since routes pass `user_id=None` the query matches all rows,
  so it is global rather than per-user. Inish chose to leave it for now.
- **Saved lectures have no audio.** `save-transcript.js` never sends `audio_path`, and
  `lectures.js` has no player — playback only works for the recording made in the
  current tab.
- **`summary` is never generated or written**, despite the column and the UI panel.

## Working agreement (from `~/.claude/CLAUDE.md`)

- Plan first, wait for approval, then report after each step with a short snippet — not
  the whole file.
- Lean prose. One recommendation with a reason, not option surveys.
- **Never list Claude as a contributor.** No `Co-Authored-By`, no "Generated with", no
  mention in commits or PRs.
- Feature branches off main named `feature/<slug>`; merge with `--no-ff`, tag semver,
  push with `--follow-tags`.
