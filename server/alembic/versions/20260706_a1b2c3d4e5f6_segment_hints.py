"""segment hints + custom tag category

Revision ID: a1b2c3d4e5f6
Revises: ef39fcdfddfa
Create Date: 2026-07-06 03:00:00.000000

Hand-written: adds the unverified author-computed `hints` blob to segments and
widens the tag category check to allow user-created free tags ('custom').
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'a1b2c3d4e5f6'
down_revision: str | None = 'ef39fcdfddfa'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('segments', sa.Column('hints', sa.JSON(), nullable=True))
    op.drop_constraint(op.f('ck_tags_category_known'), 'tags', type_='check')
    op.create_check_constraint(
        'category_known', 'tags', "category IN ('opener', 'skill', 'custom')"
    )


def downgrade() -> None:
    op.drop_constraint(op.f('ck_tags_category_known'), 'tags', type_='check')
    op.create_check_constraint(
        'category_known', 'tags', "category IN ('opener', 'skill')"
    )
    op.drop_column('segments', 'hints')
