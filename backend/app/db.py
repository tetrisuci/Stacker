"""Database wiring: SQLite by default, Postgres by swapping DATABASE_URL.

Everything schema-side sticks to portable column types (CHAR(36) uuids,
integers, text, blobs) so the same models run on both engines; only the URL
changes. Add Alembic before the first real migration.
"""

import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./stacker.db")

# check_same_thread only applies to SQLite; harmless to omit elsewhere.
_connect_args = (
    {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
)

engine = create_engine(DATABASE_URL, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency: one session per request."""
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables (skeleton stand-in for Alembic migrations)."""
    from . import models  # noqa: F401  (register mappings)

    Base.metadata.create_all(engine)
