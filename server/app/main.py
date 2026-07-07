"""App factory. `app` at module scope is what uvicorn serves; tests build
their own instance via create_app() and override the get_db dependency."""

from typing import Annotated

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import router as auth_router
from .config import get_settings
from .db import get_db
from .replays import router as replays_router
from .reports import router as reports_router
from .segments import router as segments_router

DbSession = Annotated[Session, Depends(get_db)]


def create_app() -> FastAPI:
    app = FastAPI(title="Stacker server", version="0.1.0")
    # The browser app runs on another port in dev; cookies flow because
    # localhost:5173 → localhost:8000 is same-site (SameSite=Lax), but the
    # responses need CORS with credentials to be readable.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[get_settings().frontend_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(auth_router)
    app.include_router(replays_router)
    app.include_router(segments_router)
    app.include_router(reports_router)

    @app.get("/health")
    def health(db: DbSession) -> dict[str, str]:
        # A real round-trip, so /health also proves DATABASE_URL works.
        db.execute(text("SELECT 1"))
        return {"status": "ok", "database": "ok"}

    return app


app = create_app()
