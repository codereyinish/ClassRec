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

from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from logger import logger
from models import Class, Session

MAX_SESSIONS_PER_USER = 7


# ======= CLASSES =======

def create_class(db: DBSession, *, name: str, embedding: bytes,
                 user_id: str | None = None, threshold: float = 0.4) -> Class:
    obj = Class(name=name, embedding=embedding, user_id=user_id, threshold=threshold)
    db.add(obj)        # stage the new row in the session
    db.commit()        # write it to the DB (one transaction)
    db.refresh(obj)    # reload from DB so obj.id (auto-assigned) is filled in
    logger.info(f"[repo] created class id={obj.id} name={name!r}")
    return obj


def get_class(db: DBSession, class_id: int) -> Class | None:
    return db.get(Class, class_id)          # fetch by primary key (or None)


def list_classes(db: DBSession, user_id: str | None = None) -> list[Class]:
    stmt = select(Class)                                  # SELECT * FROM classes
    if user_id is not None:
        stmt = stmt.where(Class.user_id == user_id)       # ... WHERE user_id = ?
    stmt = stmt.order_by(Class.created_at.desc())         # ... ORDER BY created_at DESC
    return list(db.execute(stmt).scalars().all())         # run it -> list of Class objects


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


def save_session(db: DBSession, *, class_id: int, user_id: str, title: str,
                 transcript: str, words: list | None = None,
                 audio_path: str | None = None) -> Session:
    obj = Session(
        class_id=class_id, user_id=user_id, title=title, transcript=transcript,
        words_json=json.dumps(words) if words is not None else None,
        audio_path=audio_path,
    )
    db.add(obj); db.commit(); db.refresh(obj)

    # 7-per-user cap: order newest-first, then .offset(7) skips the keepers ->
    # whatever's left is the old sessions to evict.
    stmt = (
        select(Session)
        .where(Session.user_id == user_id)
        .order_by(Session.created_at.desc(), Session.id.desc())
        .offset(MAX_SESSIONS_PER_USER)
    )
    to_evict = db.execute(stmt).scalars().all()
    for old in to_evict:
        _delete_audio_file(old.audio_path)      # file FIRST (need the path)
        db.delete(old)                          # then the row
    if to_evict:
        db.commit()

    logger.info(f"[repo] saved session id={obj.id} (evicted {len(to_evict)} over cap)")
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
    _delete_audio_file(obj.audio_path)          # file first
    db.delete(obj)                              # then row
    db.commit()
    logger.info(f"[repo] deleted session id={session_id}")
