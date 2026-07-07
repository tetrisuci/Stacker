"""segments.score becomes a Wilson-score float

Revision ID: b7c8d9e0f1a2
Revises: a1b2c3d4e5f6
Create Date: 2026-07-06 12:00:00.000000

Hand-written: `score` was the integer ups - downs; it now holds the Wilson
score lower bound of (ups, downs), recomputed on every vote change, so
sort=top ranks by confidence rather than raw ratio or count. Existing rows
have no votes yet, so no backfill is needed beyond the type change.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b7c8d9e0f1a2'
down_revision: str | None = 'a1b2c3d4e5f6'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        'segments',
        'score',
        type_=sa.Float(),
        existing_type=sa.Integer(),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        'segments',
        'score',
        type_=sa.Integer(),
        existing_type=sa.Float(),
        existing_nullable=False,
        postgresql_using='round(score)::integer',
    )
