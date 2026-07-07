"""Database access — synchronous SQLAlchemy 2.x on psycopg v3.

Sync over async, deliberately: FastAPI runs sync endpoints in a threadpool, so
plain `Session` code doesn't block the event loop; Alembic, pytest fixtures,
and transaction management all stay one-honest-layer simple; and psycopg v3
supports async, so flipping to `create_async_engine` later is an isolated
change to this module plus endpoint signatures — not a rewrite.
"""

from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings


@lru_cache
def get_engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True)


@lru_cache
def get_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request. Tests override this to
    inject a rollback-wrapped session bound to db-test."""
    session = get_sessionmaker()()
    try:
        yield session
    finally:
        session.close()
