from __future__ import annotations

from collections.abc import Generator
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


def get_database_url() -> str:
    return os.getenv("DATABASE_URL") or os.getenv("TSBOT_DATABASE_URL") or "sqlite:///./tsbot.db"


def get_sqlite_db_path() -> str | None:
    database_url = get_database_url()
    sqlite_prefix = "sqlite:///"
    if not database_url.startswith(sqlite_prefix):
        return None
    return database_url.removeprefix(sqlite_prefix)


_engine = create_engine(get_database_url(), connect_args={"check_same_thread": False})
_SessionLocal = sessionmaker(bind=_engine, autocommit=False, autoflush=False)


class Base(DeclarativeBase):
    pass


def create_db_and_tables() -> None:
    from . import models  # noqa: F401

    Base.metadata.create_all(_engine)


def new_session() -> Session:
    return _SessionLocal()


def get_session() -> Generator[Session, None, None]:
    session = _SessionLocal()
    try:
        yield session
    finally:
        session.close()
