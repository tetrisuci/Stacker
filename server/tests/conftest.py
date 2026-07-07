"""Test fixtures: migrations once per session against db-test, then a
per-test transaction that always rolls back.

- `engine` (session-scoped) connects to TEST_DATABASE_URL — the tmpfs-backed
  db-test container — and runs `alembic upgrade head` once, so tests exercise
  the real migration path, not a create_all() approximation.
- `db_session` (per test) opens a connection-level transaction and binds a
  Session with join_transaction_mode="create_savepoint": code under test may
  commit() freely (it releases a savepoint), and the outer transaction is
  rolled back at teardown. Isolation without per-test schema churn.
"""

import os
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.auth import (
    SESSION_COOKIE,
    DiscordUser,
    get_discord_oauth,
    issue_session_token,
)
from app.db import get_db
from app.main import create_app
from app.models import User
from app.storage import get_storage, replay_key

SERVER_DIR = Path(__file__).resolve().parents[1]


class FakeDiscord:
    """Offline stand-in for the Discord round-trips."""

    def __init__(self) -> None:
        self.user = DiscordUser(id="999001", username="promo", avatar_url=None)

    def authorize_url(self, state: str) -> str:
        return (
            "https://discord.com/oauth2/authorize"
            f"?client_id=test&response_type=code&scope=identify&state={state}"
        )

    def exchange(self, code: str) -> DiscordUser:
        return self.user


class FakeStorage:
    """In-memory stand-in for the S3 wrapper; records every put."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.put_count = 0

    def put_replay(self, sha256: str, raw: bytes) -> str:
        key = replay_key(sha256)
        self.objects[key] = raw
        self.put_count += 1
        return key

    def put_thumbnail(self, segment_id: str, raw: bytes) -> str:
        key = f"thumbnails/{segment_id}.png"
        self.objects[key] = raw
        self.put_count += 1
        return key

    def get_replay(self, storage_key: str):
        yield self.objects[storage_key]

    def get_thumbnail(self, storage_key: str):
        yield self.objects[storage_key]


@pytest.fixture(scope="session")
def engine():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.fail(
            "TEST_DATABASE_URL is not set — tests run against the db-test "
            "container only (make test)"
        )
    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVER_DIR / "alembic"))
    cfg.attributes["sqlalchemy_url"] = url
    command.upgrade(cfg, "head")

    engine = create_engine(url)
    yield engine
    engine.dispose()


@pytest.fixture
def db_session(engine):
    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(
            bind=connection,
            autoflush=False,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        try:
            yield session
        finally:
            session.close()
            transaction.rollback()


@pytest.fixture
def fake_storage():
    return FakeStorage()


@pytest.fixture
def fake_discord():
    return FakeDiscord()


@pytest.fixture
def client(db_session, fake_storage, fake_discord):
    app = create_app()

    def _test_db():
        yield db_session

    app.dependency_overrides[get_db] = _test_db
    app.dependency_overrides[get_storage] = lambda: fake_storage
    app.dependency_overrides[get_discord_oauth] = lambda: fake_discord
    with TestClient(app) as c:
        yield c


@pytest.fixture
def current_user(db_session) -> User:
    user = User(username="zhiyuan", discord_id="424242")
    db_session.add(user)
    db_session.flush()
    return user


@pytest.fixture
def auth_client(client, current_user):
    """`client` with a valid session cookie for `current_user`."""
    client.cookies.set(SESSION_COOKIE, issue_session_token(current_user.id))
    return client


@pytest.fixture
def admin_user(db_session) -> User:
    user = User(username="mod", discord_id="777001", is_admin=True)
    db_session.add(user)
    db_session.flush()
    return user
