# Architecture Decisions — Database Layer

Context: ClassRec needs to **persist** data — classes (each with one professor
voice embedding) and sessions (lecture transcripts). Until now nothing was
saved: live transcription streamed to the browser and vanished on refresh.

This document records *why* the storage stack is what it is, so future-me (and
anyone else) doesn't have to re-derive it.

---

## Data model

```
USER ──owns many──> CLASS ──has many──> SESSION (a lecture)
                    (name + ONE professor
                     voice embedding)
```

- **classes** — `id, user_id, name, embedding (BLOB), threshold, created_at`
  One class = one professor voice fingerprint. Enroll once, reuse forever.
  Despite the name this row describes a *voice*; the course it belongs to is not
  stored on the server at all. Decision 5 separates the two.
- **sessions** — `id, class_id (FK), user_id, title, transcript, summary,
  words_json, audio_path, created_at`
  One lecture, linked to its class so it knows which embedding filtered it.
- **chunks** — `id, session_id (FK), idx, text, words_json, created_at`
  Where a lecture accumulates while it is still being recorded; emptied into the
  session row once the recording ends. See Decision 4.

Rules:
- Sessions are capped at **7 per user** (rolling — keep newest 7, evict oldest).
- Evicting/deleting a session must also delete its **audio file** (no orphans).
- Audio is stored as a **file on disk** (`audio_path` holds the path), never as
  bytes in the DB — big blobs bloat the DB and slow everything.

---

## Decision 1 — SQLite now (not Postgres) · **Accepted**

**Why SQLite:**
- Production runs on a **single droplet with a single uvicorn worker**. SQLite's
  "one writer at a time" limit is a non-issue when there's effectively one writer.
- **Zero ops:** it's just a file (`data/classrec.db`) — no separate DB server to
  install, run, patch, or secure.
- Transcripts are **tiny** (a 1-hour lecture ≈ ~50 KB of text). Even thousands of
  sessions are a few tens of MB; SQLite handles multi-GB DBs comfortably.
- Same choice as the `jobhunt` project — familiar.

**Why not Postgres yet:** it's a separate server process (ops burden, cost) that
only pays off with **multiple app servers / high write concurrency** — which we
don't have. Adopt it when we outgrow one machine, not before.

**Config in use:** WAL mode (readers don't block the single writer) and
`PRAGMA foreign_keys = ON` per connection (SQLite leaves FK enforcement OFF by
default).

---

## Decision 2 — the "engine" & access layer · raw `sqlite3` now, **SQLAlchemy planned**

The **engine** is the app's connection to a database — think of the connection
string as a phone number:

```python
"sqlite:///classrec.db"                      # talk to a local file
"postgresql://user:pass@host/classrec"       # talk to a Postgres server
```

**Currently:** `src/db.py` uses Python's built-in **`sqlite3`** with hand-written
SQL. Chosen for **learning** — you see exactly what SQL runs, and it has zero
dependencies.

**Planned:** move to **SQLAlchemy** (via **SQLModel**, which is SQLAlchemy +
Pydantic, built by FastAPI's author) when we head toward production. Why:
- **Portability** — with an ORM you never hand-write dialect-specific SQL, so
  switching SQLite → Postgres becomes a **one-line engine change**. With raw SQL
  you'd re-check/rewrite queries (placeholders, types, functions differ).
- Type-checked models, less boilerplate, FastAPI-native.

**Important caveat (not a free lunch):** changing the engine line only makes the
*code* talk to Postgres. It does **not** move existing data — the new Postgres DB
starts empty. Copying rows over (dump/load) is always a separate step, ORM or not.

---

## Decision 3 — migrations via Alembic · **Planned**

A schema *will* change over time (we already added an `audio_path` column).
`CREATE TABLE IF NOT EXISTS` does **nothing** to a table that already exists — so
in production you cannot just edit the `CREATE TABLE` or drop/recreate the table
(that deletes real data). You need **versioned, reversible migration scripts**.

- Tool: **Alembic** (works with SQLAlchemy/SQLModel).
- Each schema change = a migration file (e.g. `ALTER TABLE sessions ADD COLUMN
  audio_path TEXT`) that can be applied and rolled back.
- In dev today we just delete the throwaway DB and re-init; that stops the moment
  there's data worth keeping.

SQLite specifics to remember:
- `ALTER TABLE ... ADD COLUMN` works; `DROP COLUMN` only since SQLite 3.35 (2021).
- Deleting/NULLing data frees space as reusable "free pages" but does **not**
  shrink the file — run `VACUUM` to actually reclaim disk.

---

## Decision 4 — a lecture is buffered as chunk rows, then collapsed into one · **Accepted**

**What it achieves**

- **A lecture survives the browser.** Anything already transcribed is on disk, so
  a crashed tab, a closed laptop or a dead battery costs at most the audio that
  had not yet reached the ten-second mark. Today the same event costs the whole
  lecture, and a lecture cannot be recorded twice.
- **Server memory does not grow with the lecture.** About 4 KB per recording
  while it runs, whether it is five minutes or three hours — instead of 2.15 MB
  that climbs for an hour and multiplies by everyone recording at once.
- **Nothing already written is written again.** Each ten seconds costs one insert
  of its own 4 KB. The alternative of appending into the existing column rewrote
  the whole lecture on every flush: 13.2 MB of writes for a 0.44 MB result.
- **A finished lecture is still one row.** The chunks are joined back into
  `sessions.transcript` and `sessions.words_json` and deleted, so everything that
  reads a lecture — My Lectures, the detail route, playback — is untouched, and
  existing lectures need no migration.

While a lecture is being recorded, the transcript exists in exactly one place:
the browser. The server transcribes each 10-second chunk, sends the words to the
page, and forgets them. Nothing reaches the database until someone presses Save.
So a closed tab, a crashed browser or a dead battery costs the whole lecture —
and a lecture cannot be re-recorded.

**The browser cannot fix this itself.** `beforeunload` warns before a deliberate
close, which is worth having, but it never fires for a crash or an OS-killed tab.
Anything a page sends while unloading is also capped at 64 KB, which at measured
rates covers about eight minutes of word timings. Whatever guarantees the
transcript has to live on the server, because the server is what is still running
when the browser is not.

**Measured, from a real lecture at 194 words/minute:**

| | per recording-hour |
|---|---|
| transcript text | 55 KB |
| word timings as JSON | 415 KB |
| the same words held as Python dicts | 2.15 MB |

**Rejected — keep the whole lecture in server memory, write once at the end.**
Simplest, and 2.15 MB per recording is affordable on its own. But it is held for
the entire lecture and scales with both length and concurrency: 67 simultaneous
hour-long lectures is 144 MB standing.

**Rejected — append each chunk into `sessions.words_json` as it arrives.** That
column holds a JSON array, which is a single value, and a database replaces a
value rather than extending it. Adding one chunk means reading the column,
parsing it, appending, re-serialising and writing it all back — so the whole
array is in memory at the moment of writing anyway, and the column is rewritten
from scratch every time. Measured over 60 flushes: **4.02 MB peak** (worse than
simply holding the list) and **13.2 MB written** for a lecture whose final size is
0.44 MB.

**Accepted — a `chunks` table as a write-ahead buffer.**

```
chunks: id, session_id -> sessions.id (CASCADE), idx, text, words_json, created_at
        index on (session_id, idx)
```

The session row is created when recording starts, so chunks have something to
belong to. Each arriving chunk is one INSERT — the cost of the new 4 KB, never
touching the rows already there. When the connection ends, for any reason, the
chunks are read back in `idx` order, joined, written into `sessions.transcript`
and `sessions.words_json`, and deleted.

Joining needs no arithmetic: the pipeline already adds `chunk_offset` to every
timestamp before sending it, so the timings are absolute across the lecture and
concatenation in `idx` order is the whole operation.

Measured, for a 360-chunk hour: **0.35 ms per insert**, and **91 ms** for the
collapse at a momentary 4 MB — against 2.15 MB held for the full hour by the
rejected alternative.

**Why collapse rather than keep the chunks.** Storage is not the reason; the
words cost the same either way. It is that `sessions.transcript` and
`sessions.words_json` remain the one place a finished lecture lives, so My
Lectures, the detail route and playback are unchanged, and existing lectures need
no migration. The chunks table stays private to the recording path.

**What is still lost, and when.** A chunk is written the moment it comes back
transcribed, so the gap is only the audio the server has received but not yet
formed into a chunk — bounded by `CHUNK_DURATION`, ten seconds. That is the whole
exposure for a crash, a killed tab or a dropped connection.

**Consequences to design around:**
- Reads come from the session row. Chunks are read only during the collapse, and
  as a fallback when a session has chunks but no transcript — which is precisely
  a lecture the server never got to finish, and the case the buffer exists for.
- A row now exists from the moment recording starts, so an abandoned recording
  has to be cleaned up: a session that ends with no chunks is deleted.
- Save stops creating anything. The lecture is already stored, so Save only names
  it — which also removes the duplicate rows that came from a button that
  inserted on every press.

---

## Decision 5 — a voice and a course become separate rows · **Accepted, not yet built**

Three things are tangled together today, and each one looks like a small oddity
until they are put side by side.

**The `classes` table is not classes.** It holds `embedding`, `threshold` and
`audio_path` — it describes an enrolled speaker. The UI has always called these
Voices; only the model calls them classes.

**Courses are not stored at all.** The "Course name" picker reads and writes
`localStorage` under `classrecCourses`. The comment above it says `GET /classes`,
but no such route exists. So a course disappears when someone clears their
browser, and never follows them to a second device.

**`classes.voice_name` was a patch over the first problem.** It added a second
name to the one row rather than separating the two things the row was describing.
The column is in the development database and not in the models, because the work
that added it (`feature/class-voice-name`) was never merged — which is why every
`alembic revision --autogenerate` since has offered to drop it, and three
migrations carry a comment declining.

**The shape they want to be:**

```
voices                                  classes
  id                                      id
  user_id                                 user_id
  name        "Prof. Zamaigas"            name       "bio_101"
  embedding                               voice_id -> voices.id
  threshold                               created_at
  audio_path
  use_count
  hidden
  created_at
```

A course points at the voice that teaches it. One professor across two courses is
then one voice and two courses, instead of two rows holding two copies of the same
embedding and two copies of the enrolment audio.

**What it fixes:**
- A voice named `Zamaigas_audio` — a filename standing where a course name belongs,
  which is the problem `voice_name` was reaching for.
- Courses surviving a cleared browser, and being the account's rather than the
  device's.
- Enrolling the same speaker once rather than once per course.
- The naming, so `Class` in the code means what the UI has always meant by it.

**The open question, which the schema cannot answer on its own.** `sessions`
points at a class today. After the split, does a lecture belong to the *course* it
was recorded for, or to the *voice* that was locked while it recorded? They agree
until a course's voice is changed, and then they disagree about every lecture
already recorded. Carrying both on the session keeps each answer true — the course
it belongs to, and the voice that actually filtered it — at the cost of a column.

**Sequencing.** This supersedes `feature/class-voice-name` rather than building on
it: `voice_name` has no meaning once a voice has a row of its own. So that branch
should not be merged first, and the drift is best left alone until this lands.

---

## The guiding principle

> **Start simple, stay portable.** SQLite + (later) SQLAlchemy + Alembic + a
> backup story (e.g. Litestream → object storage). Dead-simple today, becomes
> Postgres tomorrow with almost no code change, and never fear a schema change or
> lose data.

## Roadmap for this layer

- [x] SQLite schema: `classes`, `sessions` (raw `sqlite3`)
- [x] `classes` CRUD (create/get/list) — embedding stored as BLOB
- [ ] `sessions` CRUD — save (7-cap + audio cleanup), list, get, delete
- [ ] Wire `init_db()` + routes into `main.py`
- [ ] (later) SQLAlchemy/SQLModel + Alembic migrations
- [ ] (later) Postgres for scale; Litestream/managed backups
