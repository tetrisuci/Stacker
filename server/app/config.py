"""Settings via pydantic-settings, sourced from the environment (compose
injects .env). Field names map case-insensitively to env vars: database_url ←
DATABASE_URL, s3_bucket ← S3_BUCKET, and so on."""

from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Postgres everywhere (dev/test/prod) via psycopg v3 — no SQLite fallback.
    database_url: str

    # S3-compatible object storage (MinIO in dev).
    s3_endpoint_url: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str = "replays"
    s3_region: str = "us-east-1"

    # Discord OAuth + session cookie. Dev defaults let the app boot without a
    # real Discord application; set real values in .env for the login flow.
    discord_client_id: str = "dev-client-id"
    discord_client_secret: str = "dev-client-secret"
    discord_redirect_uri: str = "http://localhost:8000/auth/callback/discord"
    jwt_secret: str = "dev-jwt-secret-change-me"
    # Where the browser app lives (CORS + post-login redirect).
    frontend_origin: str = "http://localhost:5173"
    # Session-cookie attributes. In dev the frontend and API share a site
    # (localhost:5173 → localhost:8000), so SameSite=Lax over plain HTTP works.
    # In prod they're on different subdomains (stacker.* vs api.stacker.*), which
    # is *cross-site*: the browser only sends the session cookie on the frontend's
    # cross-origin fetches when it's SameSite=None AND Secure. Set both to true in
    # prod (requires HTTPS on the API). Kept as settings so one image serves both.
    #
    # Starlette's set_cookie only accepts lowercase "strict"/"lax"/"none" and
    # asserts otherwise — a 500 at the OAuth callback. So constrain the value here
    # (fail fast at boot on a bad COOKIE_SAMESITE) and normalize case, so a
    # `COOKIE_SAMESITE=None` typo maps to "none" instead of crashing login.
    cookie_samesite: Literal["strict", "lax", "none"] = "lax"
    cookie_secure: bool = False  # true in prod (HTTPS)

    @field_validator("cookie_samesite", mode="before")
    @classmethod
    def _normalize_samesite(cls, v: object) -> object:
        return v.lower() if isinstance(v, str) else v


@lru_cache
def get_settings() -> Settings:
    return Settings()
