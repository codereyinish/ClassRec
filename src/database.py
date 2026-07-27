"""
ClassRec — database connection (engine + sessions)
==================================================

This REPLACES the old `_connect()` helper. Three things live here:
    engine        — the connection to the DB (change 1 line to move to Postgres)
    SessionLocal  — a factory that makes "sessions" (a per-request workspace)
    get_db()      — FastAPI dependency: one session per request, closed after
"""

from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "classrec.db"

# The connection string. This ONE line is what changes for Postgres later:
#   f"postgresql+psycopg://user:pass@host/classrec"
DATABASE_URL = f"sqlite:///{DB_PATH}"

# check_same_thread=False: SQLite normally pins a connection to one thread;
# FastAPI uses several, so we relax that (safe with the session-per-request pattern).
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


# SQLite leaves foreign keys OFF and rollback-journal mode by default — same
# gotcha as before. This runs the PRAGMAs on every new connection.
@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA foreign_keys=ON;")   # enforce our FK / cascade
    cur.execute("PRAGMA journal_mode=WAL;")  # readers don't block the writer
    cur.close()


# The session factory. Calling SessionLocal() gives you one workspace.
# expire_on_commit=False: objects stay usable (e.g. read obj.id) after commit.
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db():
    """
    FastAPI dependency. Used in routes as:  db = Depends(get_db)
    Opens a session for the request, and ALWAYS closes it afterward (the finally).
    'yield' hands the session to the route, then resumes here to clean up.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
