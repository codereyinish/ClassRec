"""
ClassRec — ORM models (the tables, as Python classes)
=====================================================

This REPLACES the hand-written CREATE TABLE SQL. Each class = one table;
each attribute = one column. SQLAlchemy reads these to generate the SQL.

Two tables, same as before:
    Class    — a class + its ONE professor voice embedding
    Session  — one lecture transcript, linked to its class
"""

from __future__ import annotations

import datetime

from sqlalchemy import ForeignKey, LargeBinary, String, Text, Float, DateTime, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """All models inherit from this. It's the registry the ORM uses to know
    about every table when creating them / generating migrations."""
    pass


class Class(Base):
    __tablename__ = "classes"                       # -> CREATE TABLE classes

    # id INTEGER PRIMARY KEY (auto)
    id:         Mapped[int]               = mapped_column(primary_key=True)
    # user_id TEXT (nullable)
    user_id:    Mapped[str | None]        = mapped_column(String)
    # name TEXT NOT NULL  (Mapped[str] without "| None" = NOT NULL)
    name:       Mapped[str]               = mapped_column(String)
    # embedding BLOB (nullable) — LargeBinary is SQLAlchemy's word for BLOB
    embedding:  Mapped[bytes | None]      = mapped_column(LargeBinary)
    # threshold REAL DEFAULT 0.4
    threshold:  Mapped[float]             = mapped_column(Float, default=0.4)
    # created_at — server_default=now() lets the DB fill it in
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, server_default=func.now())

    # The relationship: one Class has many Sessions. Not a column — it lets you
    # write my_class.sessions and get a list of Session objects.
    # cascade "delete-orphan": delete a class -> its sessions go too.
    sessions: Mapped[list["Session"]] = relationship(
        back_populates="course", cascade="all, delete-orphan"
    )


class Session(Base):
    __tablename__ = "sessions"                      # -> CREATE TABLE sessions

    id:         Mapped[int]               = mapped_column(primary_key=True)
    # class_id INTEGER NOT NULL, FOREIGN KEY -> classes.id, ON DELETE CASCADE
    class_id:   Mapped[int]               = mapped_column(
        ForeignKey("classes.id", ondelete="CASCADE")
    )
    user_id:    Mapped[str | None]        = mapped_column(String)
    title:      Mapped[str]               = mapped_column(String)
    transcript: Mapped[str | None]        = mapped_column(Text)
    summary:    Mapped[str | None]        = mapped_column(Text)
    words_json: Mapped[str | None]        = mapped_column(Text)
    audio_path: Mapped[str | None]        = mapped_column(String)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, server_default=func.now())

    # The other side of the relationship: each Session points back to its Class.
    # Named "course" (not "class") because `class` is a reserved word in Python.
    course: Mapped["Class"] = relationship(back_populates="sessions")
