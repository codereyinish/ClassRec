"""
ClassRec — SQLite persistence layer
===================================

One file on disk (data/classrec.db). Two tables:
    classes   — a class + its ONE professor voice embedding (enroll once, reuse)
    sessions  — one lecture transcript, linked to its class

This file (Step 1) only sets up the connection + schema. CRUD functions come next.
"""

import sqlite3
from pathlib import Path

from logger import logger

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "classrec.db"


def _connect() -> sqlite3.Connection:
    """
    Open a connection to the DB file.

    Two things happen on EVERY connection:
      - row_factory = Row  -> rows come back like dicts (row["name"]) not tuples
      - PRAGMA foreign_keys = ON -> SQLite enforces our FK links (OFF by default!)
    """
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db() -> None:
    """
    Create the data folder + tables if they don't exist yet. Safe to call
    every startup — 'IF NOT EXISTS' means it does nothing once they're there.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    with _connect() as conn:
        # WAL mode: readers don't block the single writer. Set once, persists.
        conn.execute("PRAGMA journal_mode = WAL;")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS classes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     TEXT,
                name        TEXT NOT NULL,
                embedding   BLOB,
                threshold   REAL DEFAULT 0.4,
                created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                class_id    INTEGER NOT NULL,
                user_id     TEXT,
                title       TEXT NOT NULL,
                transcript  TEXT,
                summary     TEXT,
                words_json  TEXT,
                audio_path  TEXT,
                created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
            );
            """
        )

    logger.info(f"[db] ready at {DB_PATH}")


# ======= CLASSES (a class = name + ONE professor voice embedding) =======

def create_class(name: str, embedding: bytes, user_id: str | None = None,
                 threshold: float = 0.4) -> int:
    """
    Create a class and store the professor's voice embedding.

    `embedding` goes in as raw bytes (a BLOB). The caller converts the
    NumPy array to bytes first:  embedding.astype("float32").tobytes()
    Keeping db.py free of NumPy = clean separation (storage vs ML).

    Returns the new class's id.
    """
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO classes (user_id, name, embedding, threshold) VALUES (?, ?, ?, ?)",
            (user_id, name, embedding, threshold),
        )
        new_id = cur.lastrowid
    logger.info(f"[db] created class id={new_id} name={name!r}")
    return new_id


def get_class(class_id: int) -> dict | None:
    """
    Return one class as a dict (including the embedding as raw bytes), or None.
    The caller turns the bytes back into a NumPy array where it's used:
        np.frombuffer(row["embedding"], dtype="float32")
    """
    with _connect() as conn:
        row = conn.execute("SELECT * FROM classes WHERE id = ?", (class_id,)).fetchone()
    return dict(row) if row else None


def list_classes(user_id: str | None = None) -> list[dict]:
    """
    List a user's classes, newest first — WITHOUT the embedding blob
    (a list view doesn't need the fingerprint, so we don't ship it around).
    """
    query = "SELECT id, user_id, name, threshold, created_at FROM classes "
    params: tuple = ()
    if user_id is not None:
        query += "WHERE user_id = ? "
        params = (user_id,)
    query += "ORDER BY datetime(created_at) DESC"

    with _connect() as conn:
        rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]


# Lets you set up the DB by hand:  python src/db.py
if __name__ == "__main__":
    init_db()
    print(f"Database initialized at {DB_PATH}")
