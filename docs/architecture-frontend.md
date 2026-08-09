# Architecture Decisions — Pages & Assets

Context: the app serves four pages. Three share a layout; the live page does not,
and carries roughly nine tenths of the frontend on its own. This document records
which file is loaded where, why the live page is the exception, and why the order
its scripts load in is not a detail.

Written after the redesign became `/live` (v1.6.0), when the same CSS and JS
existed twice and one of the copies had to go.

---

## What loads what

```
                                    src/main.py
                                         │  templates.env.globals →  asset_version  (?v= cache-bust on every asset)
                                         │                           clerk_key      (published Clerk key)
        ┌────────────────────────────────┼──────────────────────────────────────────────────────────┐
        │                                │                                                          │
   GET /                            GET /upload                GET /lectures                    GET /live
        │                                │                            │                              │
        ▼                                ▼                            ▼                              ▼
   index.html                       upload.html                 lectures.html                    live.html   ✦ standalone
        │                                │                            │                              │        (no base.html —
        └──── {% extends %} ─────────────┴──────────────┬─────────────┘                              │         carries its own head,
                                                        │                                            │         its own top bar)
                                                        ▼                                            │
                                                   base.html                                         │
                                                   ├─ js/tracker.js   (usage numbers)                │
                                                   └─ js/auth.js      (Clerk avatar, mounts nav)     │
                                                                                                     │
   own CSS:  css/index.css      css/upload.css      css/lectures.css                                 │
   own JS :  —                  js/upload.js        js/lectures.js                                   │
                                                                                                     │
        ┌────────────────────────────────────────────────────────────────────────────────────────────┘
        │
        ├─ <head>   Sentry · js/tracker.js · Clerk SDK · js/auth.js      ← named directly, because base.html is skipped
        │
        ├─ CSS      split three ways, and they never collide, so this order is free
        │           ├── css/live.css          52 KB   shell · tokens · dark · top bar · rail · transcript column · empty state
        │           ├── css/voice-picker.css  6.5 KB  the .vp-* saved-voice popup
        │           └── css/doubt-panel.css   6.6 KB  the AI panel on the right
        │
        ├─ inline   pre-paint theme script — stays inline on purpose; in a file it would flash white
        │
        └─ <script> ONE SHARED GLOBAL SCOPE — load order is load-bearing
                    ①  js/live.js            61 KB   117 decls   mic state machine · device picker · alerts · data layer
                    ②  js/audio-playback.js  35 KB   100 decls   playback · waveform · drag-scrub · jump-to-latest
                    ③  js/voice-picker.js    15 KB    46 decls   the popup · hold-to-enrol
                    ④  js/save-transcript.js 3.4 KB    8 decls   POST /sessions
                    ⑤  js/doubt-panel.js     4.3 KB   17 decls   what a question is asking about
```

---

## Decision 1 — the live page does not extend `base.html` · **Accepted**

Every other page does. The live page carries its own `<head>`, and therefore has
to name Sentry, `tracker.js`, the Clerk SDK and `auth.js` itself.

**Why:** the redesign replaced the shared chrome. It has its own top bar — four
things rather than eight — a theme switch, a session button and the rail. Putting
it back inside `base.html` would mean rebuilding the layout it was designed to
drop.

**The cost, so it is not a surprise later:** the head is duplicated. Change a
shared script in `base.html` and this page does not follow. That is the trade
made knowingly; the comment at the top of `live.html` says so at the point where
it matters.

---

## Decision 2 — one live page, not two · **Accepted (v1.6.0)**

The redesign shipped at `/live-v2` alongside the page it replaced, deliberately,
so the two could run side by side. That left every stylesheet and script existing
twice: once as a file under `static/`, once transcribed inline into a 4047-line
template.

`/live` now serves the redesign, `/live-v2` is gone, and the inline blocks went
back into the files they had been copied from.

```
   before   templates/live.html      173 lines   →  3 CSS + 5 JS  (the originals)
            templates/live_v2.html  4047 lines   →  all of it inlined, a second copy

   after    templates/live.html      448 lines   →  3 CSS + 5 JS  (the redesign's code)
```

**Nothing was rewritten in the move.** Verified rather than asserted:

| check | result |
|---|---|
| CSS lines against the original | 1157 → 1157, lost 0, added 0 |
| JS lines against the original | 2250 → 2250, lost 0, added 0 |
| head, pre-paint script, markup, tail | byte-identical |

---

## Decision 3 — five classic scripts, one scope, order is load-bearing · **Accepted**

The five are **not modules**. They share one global scope, exactly as the old page
had them, and they reference each other in both directions:

```
   live.js ──10 names──▶ voice-picker.js          voice-picker.js ──9 names──▶ live.js
   live.js ── 3 names──▶ save-transcript.js       audio-playback.js ─15 names─▶ live.js
   live.js ── 2 names──▶ audio-playback.js        doubt-panel.js ───5 names──▶ live.js
```

That reads as circular and would break, except every cross-reference sits **inside
a function body**, so it resolves when called — long after all five have loaded.
Only top-level code runs during loading, and `live.js` is the only file whose
top-level code depends on anything. Hence it loads first.

**This is the page's recurring bug, not a hypothetical.** Three separate breakages
have had the same shape: a top-level statement touching a `const` declared further
down. It throws while the script is still executing, so every handler below it is
never bound — the page renders perfectly and nothing works.

`scripts/check-live-page.js` exists for exactly that. It joins the five files in
the order `live.html` loads them and checks three things:

```
   1. syntax
   2. identifiers used at the top level that nothing declares
   3. top-level reads of a const/let declared later  (temporal dead zone)
```

Faults are reported as `file:line`. **Run it after touching any of the five, and
after any change to the order:**

```bash
node scripts/check-live-page.js
```

The `FILES` array in that script and the `<script>` tags in `live.html` are the
same list written twice. Changing one without the other makes the check
meaningless.

---

## Decision 4 — the stylesheets are split three ways, and provably do not collide · **Accepted**

Splitting CSS usually means the cascade starts mattering. Here it does not, and
that was checked rather than hoped:

| | selectors | keyframes |
|---|---|---|
| `live.css` | 327 | `lvl`, `spin` |
| `doubt-panel.css` | 58 | — |
| `voice-picker.css` | 51 | `twinkle` |

**No selector appears in two files, and no `@keyframes` name is shared.** With
disjoint selectors the order of the three `<link>` tags cannot change rendering,
so the page keeps the order the old one used.

Adding a rule that also exists in a sibling file breaks that property silently.

---

## Decision 5 — the theme script stays inline · **Accepted**

A ten-line IIFE sits between `</head>` and `<body>`, reading the saved theme and
setting `data-theme` before anything paints.

Moving it into a file would make it a separate request resolved after the first
paint, which is a white flash on the way into a dark page. It is inline because
of *when* it must run, not because it is small.

A saved choice beats the system preference: someone who chose is telling you
something the OS is not.

---

## The guiding principle

> **Every page's assets are named where that page is defined.** No implicit
> loading, no bundler, no module graph to reason about — a `<link>` or a
> `<script>` you can read. The cost is that the live page repeats `base.html`'s
> head; the benefit is that nothing loads that the page did not ask for.

## Open items

- [x] One live page, one copy of its code (v1.6.0)
- [x] `check-live-page.js` follows the five files rather than an inline block
- [ ] **End-to-end recording on the restructured page is unverified** — the proofs
      cover content and load order, not the microphone path
- [ ] `base.html`'s head and `live.html`'s head drift independently — no guard
- [ ] The other three pages still carry the earlier theme; only the live page has
      the redesign
