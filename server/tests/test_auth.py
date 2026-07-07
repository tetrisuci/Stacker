"""Discord OAuth flow (offline via FakeDiscord), sessions, and write gating."""

from urllib.parse import parse_qs, urlparse

from app.auth import SESSION_COOKIE, issue_session_token
from app.models import User

from .test_replays import make_ttr, upload


def _do_login_roundtrip(client) -> None:
    """Drive login -> callback with the state cookie the login step set."""
    login = client.get("/auth/login/discord", follow_redirects=False)
    assert login.status_code == 307
    location = urlparse(login.headers["location"])
    assert location.netloc == "discord.com"
    q = parse_qs(location.query)
    assert q["response_type"] == ["code"] and q["scope"] == ["identify"]
    state = q["state"][0]
    cb = client.get(
        "/auth/callback/discord",
        params={"code": "fake-code", "state": state},
        follow_redirects=False,
    )
    assert cb.status_code == 307, cb.text
    assert cb.headers["location"].endswith("/train")


def test_me_requires_session(client):
    assert client.get("/me").status_code == 401


def test_login_callback_upserts_and_sets_session(client, db_session, fake_discord):
    _do_login_roundtrip(client)

    # The callback set a session cookie: /me now works.
    me = client.get("/me")
    assert me.status_code == 200
    assert me.json()["username"] == "promo"

    # Same Discord id again -> same account (upsert, avatar refreshed).
    first = db_session.query(User).filter_by(discord_id="999001").one()
    fake_discord.user.avatar_url = "https://cdn.discordapp.com/avatars/x.png"
    _do_login_roundtrip(client)
    users = db_session.query(User).filter_by(discord_id="999001").all()
    assert len(users) == 1 and users[0].id == first.id
    assert users[0].avatar_url == "https://cdn.discordapp.com/avatars/x.png"


def test_username_collision_gets_suffix(client, db_session):
    db_session.add(User(username="promo"))  # unrelated account, no Discord
    db_session.flush()
    _do_login_roundtrip(client)
    assert client.get("/me").json()["username"] == "promo-9001"


def test_callback_rejects_state_mismatch(client):
    client.get("/auth/login/discord", follow_redirects=False)
    res = client.get(
        "/auth/callback/discord",
        params={"code": "fake-code", "state": "forged-state"},
        follow_redirects=False,
    )
    assert res.status_code == 400


def test_logout_clears_session(auth_client):
    assert auth_client.get("/me").status_code == 200
    res = auth_client.post("/auth/logout", follow_redirects=False)
    # The response instructs the browser to drop the session cookie. (The test
    # client's jar holds a manually-set cookie that deletion rules don't
    # match, so assert on the header — what a real browser obeys.)
    cleared = res.headers.get("set-cookie", "")
    assert 'session=""' in cleared and "Max-Age=0" in cleared
    auth_client.cookies.clear()
    assert auth_client.get("/me").status_code == 401


def test_upload_is_gated(client, db_session):
    # Anonymous first (auth_client would pre-set the shared cookie jar).
    res = upload(client, make_ttr())
    assert res.status_code == 401

    user = User(username="zhiyuan")
    db_session.add(user)
    db_session.flush()
    client.cookies.set(SESSION_COOKIE, issue_session_token(user.id))
    res = upload(client, make_ttr())
    assert res.status_code == 201
    assert res.json()["uploaderUsername"] == "zhiyuan"
