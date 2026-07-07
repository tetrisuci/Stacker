"""Discord OAuth + JWT session cookie.

Flow: GET /auth/login/discord 307s to Discord's authorize page (with a CSRF
state cookie); Discord sends the user back to GET /auth/callback/discord,
which exchanges the code, upserts the user by Discord id, sets an HttpOnly
`session` cookie (JWT, HS256), and redirects to the frontend. GET /me reads
the cookie; write endpoints depend on `get_current_user`.

The Discord HTTP calls live behind the `DiscordOAuth` dependency so tests can
substitute a fake without network access.
"""

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import User
from .schemas import ApiModel

router = APIRouter(tags=["auth"])

DbSession = Annotated[Session, Depends(get_db)]

SESSION_COOKIE = "session"
STATE_COOKIE = "oauth_state"
SESSION_TTL = timedelta(days=7)

DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize"
DISCORD_TOKEN = "https://discord.com/api/oauth2/token"  # noqa: S105 — URL
DISCORD_ME = "https://discord.com/api/users/@me"


@dataclass
class DiscordUser:
    id: str
    username: str
    avatar_url: str | None


class DiscordOAuth:
    """The two Discord round-trips, isolated for test substitution."""

    def __init__(self) -> None:
        self._settings = get_settings()

    def authorize_url(self, state: str) -> str:
        s = self._settings
        params = httpx.QueryParams(
            client_id=s.discord_client_id,
            redirect_uri=s.discord_redirect_uri,
            response_type="code",
            scope="identify",
            state=state,
        )
        return f"{DISCORD_AUTHORIZE}?{params}"

    def exchange(self, code: str) -> DiscordUser:
        s = self._settings
        token_res = httpx.post(
            DISCORD_TOKEN,
            data={
                "client_id": s.discord_client_id,
                "client_secret": s.discord_client_secret,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": s.discord_redirect_uri,
            },
            timeout=10,
        )
        token_res.raise_for_status()
        access_token = token_res.json()["access_token"]
        me_res = httpx.get(
            DISCORD_ME,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        me_res.raise_for_status()
        me = me_res.json()
        avatar = me.get("avatar")
        return DiscordUser(
            id=str(me["id"]),
            username=me.get("global_name") or me["username"],
            avatar_url=(
                f"https://cdn.discordapp.com/avatars/{me['id']}/{avatar}.png"
                if avatar
                else None
            ),
        )


def get_discord_oauth() -> DiscordOAuth:
    return DiscordOAuth()


DiscordDep = Annotated[DiscordOAuth, Depends(get_discord_oauth)]


# ---- JWT session ----


def issue_session_token(user_id: str) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {"sub": user_id, "iat": now, "exp": now + SESSION_TTL},
        get_settings().jwt_secret,
        algorithm="HS256",
    )


def get_current_user(request: Request, db: DbSession) -> User:
    """Auth dependency for write endpoints: 401 unless a valid session."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="not logged in")
    try:
        payload = jwt.decode(
            token, get_settings().jwt_secret, algorithms=["HS256"]
        )
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail="invalid session") from e
    user = db.get(User, str(payload.get("sub")))
    if user is None:
        raise HTTPException(status_code=401, detail="unknown user")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_optional_user(request: Request, db: DbSession) -> User | None:
    """Like get_current_user, but anonymous (or stale) sessions yield None
    instead of 401 — for reads that personalize when logged in (my_vote)."""
    if not request.cookies.get(SESSION_COOKIE):
        return None
    try:
        return get_current_user(request, db)
    except HTTPException:
        return None


OptionalUser = Annotated[User | None, Depends(get_optional_user)]


def get_admin_user(user: CurrentUser) -> User:
    """Auth dependency for moderation endpoints: valid session AND is_admin."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="admin only")
    return user


AdminUser = Annotated[User, Depends(get_admin_user)]


# ---- endpoints ----


class MeOut(ApiModel):
    id: str
    username: str
    avatar_url: str | None
    is_admin: bool


@router.get("/auth/login/discord")
def login_discord(oauth: DiscordDep) -> RedirectResponse:
    state = secrets.token_urlsafe(24)
    response = RedirectResponse(oauth.authorize_url(state), status_code=307)
    response.set_cookie(
        STATE_COOKIE, state, max_age=600, httponly=True, samesite="lax"
    )
    return response


@router.get("/auth/callback/discord")
def callback_discord(
    request: Request,
    code: str,
    state: str,
    db: DbSession,
    oauth: DiscordDep,
) -> RedirectResponse:
    if request.cookies.get(STATE_COOKIE) != state:
        raise HTTPException(status_code=400, detail="OAuth state mismatch")
    try:
        duser = oauth.exchange(code)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail="Discord exchange failed") from e

    user = db.scalar(select(User).where(User.discord_id == duser.id))
    if user is None:
        user = User(
            username=_unique_username(db, duser),
            discord_id=duser.id,
            avatar_url=duser.avatar_url,
        )
        db.add(user)
    else:
        user.avatar_url = duser.avatar_url
    db.commit()

    settings = get_settings()
    response = RedirectResponse(
        f"{settings.frontend_origin}/train", status_code=307
    )
    # The session cookie must reach the frontend's cross-origin fetches. When the
    # frontend and API are on different subdomains (prod), that requires
    # SameSite=None; Secure; same-site dev keeps Lax over plain HTTP.
    response.set_cookie(
        SESSION_COOKIE,
        issue_session_token(user.id),
        max_age=int(SESSION_TTL.total_seconds()),
        httponly=True,
        samesite=settings.cookie_samesite,
        secure=settings.cookie_secure,
    )
    response.delete_cookie(STATE_COOKIE)
    return response


def _unique_username(db: Session, duser: DiscordUser) -> str:
    """Discord display names aren't unique here; suffix on collision."""
    taken = db.scalar(select(User).where(User.username == duser.username))
    if taken is None:
        return duser.username
    return f"{duser.username}-{duser.id[-4:]}"


@router.post("/auth/logout")
def logout() -> RedirectResponse:
    response = RedirectResponse(get_settings().frontend_origin, status_code=307)
    response.delete_cookie(SESSION_COOKIE)
    return response


@router.get("/me", response_model=MeOut)
def me(user: CurrentUser):
    return MeOut.model_validate(user)
