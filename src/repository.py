"""
ClassRec — repository (all data operations, via the ORM)
========================================================

Replaces the raw-SQL db.py. Same operations, but each function takes a
SQLAlchemy session `db` (handed in by FastAPI's get_db) and uses ORM calls
instead of hand-written SQL.

Naming note — there are TWO "Session"s:
    DBSession = SQLAlchemy's DB session (the per-request workspace) -> aliased
    Session   = OUR model (one lecture)
"""

import json
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session as DBSession

from logger import logger
from models import Chunk, Flag, Session, Voice

MAX_SESSIONS_PER_USER = 7


# ======= CLASSES =======

def create_voice(db: DBSession, *, name: str, embedding: bytes,
                 user_id: str | None = None, threshold: float = 0.4,
                 audio_path: str | None = None) -> Voice:
    obj = Voice(name=name, embedding=embedding, user_id=user_id,
                threshold=threshold, audio_path=audio_path)
    db.add(obj)        # stage the new row in the session
    db.commit()        # write it to the DB (one transaction)
    db.refresh(obj)    # reload from DB so obj.id (auto-assigned) is filled in
    logger.info(f"[repo] created class id={obj.id} name={name!r}")
    return obj


def rename_voice(db: DBSession, voice_id: int, new_name: str) -> Voice | None:
    """Rename a Voice. Returns the updated Voice, or None if not found."""
    obj = db.get(Voice, voice_id)
    if obj is None:
        return None
    obj.name = new_name
    db.commit()
    db.refresh(obj)
    logger.info(f"[repo] renamed voice id={voice_id} -> {new_name!r}")
    return obj


def get_voice(db: DBSession, voice_id: int) -> Voice | None:
    return db.get(Voice, voice_id)          # fetch by primary key (or None)


def list_voices(db: DBSession, user_id: str | None = None) -> list[Voice]:
    stmt = select(Voice)                                  # SELECT * FROM voices
    if user_id is not None:
        stmt = stmt.where(Voice.user_id == user_id)       # ... WHERE user_id = ?
    stmt = stmt.order_by(Voice.created_at.desc())         # ... ORDER BY created_at DESC
    return list(db.execute(stmt).scalars().all())         # run it -> list of Voice objects


def top_voices(db: DBSession, user_id: str | None = None, limit: int = 4) -> list[Voice]:
    """The Voice picker: only NON-hidden voices, most-used first, capped at `limit`."""
    stmt = select(Voice).where(Voice.hidden == False)     # noqa: E712  (SQL needs ==, not `is`)
    if user_id is not None:
        stmt = stmt.where(Voice.user_id == user_id)
    stmt = stmt.order_by(Voice.use_count.desc(), Voice.created_at.desc()).limit(limit)
    return list(db.execute(stmt).scalars().all())


def _count_sessions(db: DBSession, voice_id: int) -> int:
    """How many Lectures still reference this Voice."""
    return db.execute(
        select(func.count()).select_from(Session).where(Session.voice_id == voice_id)
    ).scalar_one()


def _gc_voice_if_orphaned(db: DBSession, voice_id: int | None) -> None:
    """Reference-count cleanup: a HIDDEN voice with zero Lectures left is truly deleted."""
    if voice_id is None:
        return
    voice = db.get(Voice, voice_id)
    if voice is not None and voice.hidden and _count_sessions(db, voice_id) == 0:
        _delete_audio_file(voice.audio_path)    # remove the enrollment clip too
        db.delete(voice)
        db.commit()
        logger.info(f"[repo] garbage-collected orphaned hidden voice id={voice_id}")


def hide_voice(db: DBSession, voice_id: int) -> None:
    """The 🗑️ in the picker. Mark hidden; if it already has no Lectures, delete it outright."""
    voice = db.get(Voice, voice_id)
    if voice is None:
        return
    voice.hidden = True
    db.commit()
    _gc_voice_if_orphaned(db, voice_id)     # no Lectures? -> remove entirely now
    logger.info(f"[repo] hid voice id={voice_id}")


# ======= SESSIONS =======

def _delete_audio_file(path: str | None) -> None:
    """Safely remove an audio file; no-op if missing, never raises."""
    if not path:
        return
    try:
        p = Path(path)
        if p.exists():
            p.unlink()
            logger.info(f"[repo] deleted audio file {path}")
    except OSError as e:
        logger.error(f"[repo] could not delete audio file {path}: {e}")


def save_session(db: DBSession, *, voice_id: int, user_id: str, title: str,
                 transcript: str, words: list | None = None,
                 audio_path: str | None = None,
                 flags: list[dict] | None = None) -> Session:
    obj = Session(
        voice_id=voice_id, user_id=user_id, title=title, transcript=transcript,
        words_json=json.dumps(words) if words is not None else None,
        audio_path=audio_path,
    )
    # Flags were raised during the lecture, before this row existed. Attaching
    # them to the relationship lets SQLAlchemy set session_id after the INSERT.
    for f in (flags or []):
        obj.flags.append(Flag(
            t_start=f["t_start"], t_end=f["t_end"], quote=f["quote"],
            question=f.get("question"), answer=f.get("answer"),
        ))
    db.add(obj)

    # Bump this Voice's usage counter (powers "top 4 most used"). voice_id may be
    # None for an unlocked recording, so guard it.
    if voice_id is not None:
        voice = db.get(Voice, voice_id)
        if voice is not None:
            voice.use_count += 1

    db.commit(); db.refresh(obj)

    evicted = _evict_over_cap(db, user_id)

    logger.info(f"[repo] saved session id={obj.id} (evicted {evicted} over cap)")
    return obj


def _evict_over_cap(db: DBSession, user_id: str) -> int:
    """Hold the user to MAX_SESSIONS_PER_USER, newest kept.

    Lifted out of save_session unchanged so the recording path can apply the same
    cap when a lecture is finished, rather than keeping a second copy of it.
    """
    # 7-per-user cap: order newest-first, then .offset(7) skips the keepers ->
    # whatever's left is the old sessions to evict.
    stmt = (
        select(Session)
        .where(Session.user_id == user_id)
        .order_by(Session.created_at.desc(), Session.id.desc())
        .offset(MAX_SESSIONS_PER_USER)
    )
    to_evict = db.execute(stmt).scalars().all()
    orphan_candidates = {old.voice_id for old in to_evict}   # Voices that just lost a Lecture
    for old in to_evict:
        _delete_audio_file(old.audio_path)      # file FIRST (need the path)
        db.delete(old)                          # then the row
    if to_evict:
        db.commit()
        for cid in orphan_candidates:           # a hidden Voice now at 0 Lectures -> delete it
            _gc_voice_if_orphaned(db, cid)
    return len(to_evict)


# ---- the recording buffer: a lecture as it is being recorded -----------------

def start_session(db: DBSession, *, user_id: int, voice_id: int | None,
                  title: str) -> Session:
    """Open the row a recording will fill, before any of it exists.

    Created at the start rather than at save because the chunks arriving over the
    next hour need something to belong to. Transcript and words stay empty until
    the recording ends and collapse_session fills them in.

    The cap is deliberately NOT applied here: a recording that is abandoned in its
    first seconds must not evict a real lecture on its way past.
    """
    obj = Session(voice_id=voice_id, user_id=user_id, title=title)
    db.add(obj); db.commit(); db.refresh(obj)
    logger.info(f"[repo] opened session id={obj.id} for user {user_id}")
    return obj


def add_chunk(db: DBSession, *, session_id: int, idx: int, text: str,
              words: list | None = None) -> None:
    """Store one transcribed chunk. The write is the size of the chunk, and
    nothing already written is touched."""
    db.add(Chunk(
        session_id=session_id, idx=idx, text=text,
        words_json=json.dumps(words) if words is not None else None,
    ))
    db.commit()


def assemble_chunks(db: DBSession, session_id: int) -> tuple[str, list]:
    """The buffer, in order, as a transcript and one word list.

    Concatenation is the whole operation: transcribe_chunk folds chunk_offset
    into every timestamp before the words leave the server, so they are already
    absolute against the lecture.
    """
    rows = db.execute(
        select(Chunk).where(Chunk.session_id == session_id).order_by(Chunk.idx)
    ).scalars().all()
    transcript = "\n\n".join(r.text for r in rows if r.text)
    words = [w for r in rows if r.words_json for w in json.loads(r.words_json)]
    return transcript, words


def collapse_session(db: DBSession, session_id: int) -> Session | None:
    """Fold the buffer into the lecture and drop it.

    Runs when a recording ends, however it ended. Afterwards the lecture is one
    row in the shape everything else already reads, and the chunks are gone.

    A session with no chunks was never a lecture — a connection that opened and
    closed, or one refused before any audio arrived — so it is deleted rather
    than left as an empty row in someone's list. Returns None in that case.
    """
    obj = db.get(Session, session_id)
    if obj is None:
        return None

    transcript, words = assemble_chunks(db, session_id)
    if not transcript:
        db.delete(obj); db.commit()
        logger.info(f"[repo] session id={session_id} had no transcript, removed")
        return None

    obj.transcript = transcript
    obj.words_json = json.dumps(words) if words else None
    db.execute(delete(Chunk).where(Chunk.session_id == session_id))

    # Bump this Voice's usage counter, as save_session does — here rather than at
    # start_session, so an abandoned recording does not count as having used it.
    if obj.voice_id is not None:
        voice = db.get(Voice, obj.voice_id)
        if voice is not None:
            voice.use_count += 1

    db.commit(); db.refresh(obj)
    evicted = _evict_over_cap(db, obj.user_id)
    logger.info(f"[repo] collapsed session id={session_id}: {len(transcript)} chars, "
                f"{len(words)} words (evicted {evicted} over cap)")
    return obj


def list_sessions(db: DBSession, user_id: str | None = None) -> list[Session]:
    stmt = select(Session)
    if user_id is not None:
        stmt = stmt.where(Session.user_id == user_id)
    stmt = stmt.order_by(Session.created_at.desc(), Session.id.desc())
    return list(db.execute(stmt).scalars().all())


def get_session(db: DBSession, session_id: int) -> Session | None:
    return db.get(Session, session_id)


def delete_session(db: DBSession, session_id: int) -> None:
    obj = db.get(Session, session_id)
    if obj is None:
        return
    voice_id = obj.voice_id                      # remember before deleting
    _delete_audio_file(obj.audio_path)          # file first
    db.delete(obj)                              # then row
    db.commit()
    _gc_voice_if_orphaned(db, voice_id)         # hidden Voice now at 0 Lectures -> delete it
    logger.info(f"[repo] deleted session id={session_id}")
