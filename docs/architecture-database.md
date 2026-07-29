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
- **sessions** — `id, class_id (FK), user_id, title, transcript, summary,
  words_json, audio_path, created_at`
  One lecture, linked to its class so it knows which embedding filtered it.

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
