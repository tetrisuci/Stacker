"""FastAPI app: curated-timeframes backend (skeleton).

    uvicorn app.main:app --reload

See backend/README.md for the schema and API contract.
"""

from fastapi import FastAPI

from .db import init_db
from .routes import replays, timeframes

app = FastAPI(
    title="Stacker curated timeframes",
    version="0.1.0",
    description=(
        "Ingests .ttr replays, stores their reconstruction "
        "(JS placement-track contract), and serves community-curated "
        "training timeframes."
    ),
)

app.include_router(replays.router)
app.include_router(timeframes.router)


@app.on_event("startup")
def _startup() -> None:
    # Skeleton stand-in for migrations.
    init_db()


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
