# Architecture Decisions — Deploy & Migration

Context: pushing to `main` fires `.github/workflows/deploy.yml`, which SSHes into
the droplet and updates a **running** app in place. Two things change underneath
live users — the code and the schema — and the order they change in is the whole
design.

This document records what happens, in what order, and what survives each
failure, so future-me doesn't have to re-read the workflow to answer
"is anything lost?"

---

## The pipeline

```
  git pull ──> backup ──> prune ──> alembic upgrade ──> systemctl restart
     22          39         48            55                  57
      │           │                        │                   │
   files on    copy to                 schema is           process is
   disk are    backups/                rewritten           replaced
   replaced                                                     ▲
                                                                │
                       app is LIVE on old code ─────────────────┘
                       through every step before this one
```

`set -e` (line 20) stops at the first failure, so a broken step never reaches the
restart.

---

## Decision 1 — the restart is the switch, not the pull · **Accepted**

`git pull` replaces changed files **whole** (git has no concept of patching lines
on disk). Unchanged files are never opened. Untracked paths — `data/`, `backups/`,
`.env`, `venv/` — are left alone, which is why the database survives a deploy.

But the running process already compiled its code into memory at startup. New
files on disk change nothing until line 57.

| | on disk | in the running process |
|---|---|---|
| after `git pull` | **new** | old |
| after `systemctl restart` | new | **new** |

**Consequences:**
- **Downtime is the restart window**, and it is not small — startup loads Whisper,
  Silero VAD, pyannote segmentation and ECAPA-TDNN. Tens of seconds refusing
  connections.
- **Live WebSockets die.** An HTTP request retries; a lecture being recorded does
  not. This is the real cost of a restart here.
- **`templates/` and `static/` are read per request**, not held in RAM. So between
  line 22 and line 57 a page load gets **new frontend against old backend**. Brief,
  usually harmless, occasionally not.

**Not yet addressed:** pulling into a fresh directory and switching a symlink at
the end would collapse that mixed window, and a warmed second process would
remove the outage. Neither is built; at current scale neither is urgent.

---

## Decision 2 — schema goes up before the code · **Accepted**

Line 55 runs before line 57, deliberately.

```
  migrate ─> restart      old code, new schema, briefly     ← safe if additive
  restart ─> migrate      new code, old schema              ← guaranteed crash
```

Alembic is safe to run every deploy: it applies only what is missing and does
nothing when nothing is pending.

**The case this does not cover:** a *destructive* migration. Drop a column the old
process still SELECTs and it errors until the restart lands.

---

## Decision 3 — a migration rebuilds tables, never the file · **Accepted (SQLite behaviour)**

There is **one file, always**: `data/classrec.db`. Never replaced, never renamed.
The app's path and connection are identical before and after — **nothing is
reconfigured.**

SQLite cannot `ALTER` a column's type or constraints, so Alembic's
`batch_alter_table` rebuilds the table *inside* that file:

```
  1. CREATE TABLE _alembic_tmp_classes (new shape)
  2. INSERT INTO _alembic_tmp_classes SELECT * FROM classes    ← rows copied
  3. DROP TABLE classes                                        ← old one gone here
  4. ALTER TABLE _alembic_tmp_classes RENAME TO classes        ← name taken over
```

| | `classes` | `_alembic_tmp_classes` |
|---|---|---|
| start | old shape, all rows | — |
| after 2 | old shape, all rows | new shape, **rows copied** |
| after 3 | — | new shape, all rows |
| after 4 | **new shape, all rows** | — |

Step 4 is why no code changes: the new table takes the original name. Drop
precedes rename because two tables cannot share a name.

**Costs to remember:**
- Step 2 copies **every row** — time scales with table size. `chunks` grows per
  lecture; it is the one to watch.
- The table is **locked** during the copy, and the old app is still serving
  (Decision 2), so writes in that window hit `database is locked`.
- **The file does not shrink.** Dropped pages are reused, not returned. `VACUUM`
  reclaims disk and rewrites the whole file — maintenance job, not a deploy step.

---

## Decision 4 — a copy before the schema is touched · **Accepted, never yet executed**

Alembic's SQLite impl logs *"Will assume non-transactional DDL"* and **commits
after each migration**. So the unit of atomicity is **one migration, not the run**:

```
  5 pending, the 5th fails  ─>  first 4 are COMMITTED and stay
                                the 5th rolls back cleanly
                                alembic_version = the 4th
```

Verified on a copy of production data (Aug 2026): a deliberate failure in
`8f2b1c4d9a07` left `flags`, `users`, `chunks` in place, `classes` un-renamed, no
`_alembic_tmp_*` debris, and `alembic_version` agreeing with the actual schema.

**So a failed run leaves you consistent but partway up the stack.** Recovery is
normally to fix the offending migration and re-run — it resumes from where it
stopped. The backup is for when that isn't possible.

Within a single migration the guarantee does hold: under WAL, work goes to
`classrec.db-wal` and is made real by one commit record. No commit record means
the main file was never modified — nothing is undone, it simply never applied.

That covers a failed migration. It does **not** cover a migration that succeeds
onto code that then doesn't work. Hence line 39: a consistent copy taken before
anything is touched, `.backup` rather than a file copy because WAL keeps recent
writes outside the `.db`.

Line 48 keeps the newest five. A copy is useful only while restoring it wouldn't
throw away every lecture recorded since. It is on the **same disk** — not
protection against losing the droplet. That is a different copy, elsewhere, on a
schedule, and it is not built.

---

## What survives what

| failure | old schema | old data | app | action |
|---|---|---|---|---|
| backup step fails | intact | intact | **still serving old code** | fix, push again |
| migration errors mid-way | **partly migrated**, consistent | intact | **still serving old code** | fix that migration, push again — it resumes |
| killed / rebooted mid-migration | **partly migrated**, consistent | intact | restarts on old code | same — resume |
| **migration succeeds, new code breaks on it** | **gone** | at risk | broken | **restore from `backups/`** |

Restore is manual, and the code must go back too or it re-breaks:

```bash
systemctl stop classrec
cp backups/classrec-<stamp>.db data/classrec.db
systemctl start classrec
```

**Cost:** everything written between the backup and the restore is lost.
**Therefore:** open the app and check it after any deploy carrying a migration.
A problem caught in five minutes is a non-event; caught in five days it is a
choice between a broken app and losing five days of lectures.

---

## The guiding principle

> **Nothing irreversible happens before something reversible has been proven.**
> Copy first, migrate second, restart last, and stop at the first failure — so the
> normal failure leaves a live app on old code, and only the rare one needs the
> backup at all.

## Open items

- [x] Auto-deploy on push to `main` (`git pull` + restart)
- [x] Alembic runs before the restart
- [x] Backup + prune-to-five written into the workflow
- [ ] **Backup has never successfully run** — the committed version calls the
      `sqlite3` *command*, absent on the droplet, which is where the deploy
      stalled. Fix (Python's stdlib `sqlite3` module, always present) is written
      but uncommitted.
- [ ] Copy backups **off** the droplet — same-disk copies don't survive the machine
- [ ] Close the restart gap: fresh directory + symlink switch, warmed second process
