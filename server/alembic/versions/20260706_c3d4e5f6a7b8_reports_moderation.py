"""reports on replays + admin flag

Revision ID: c3d4e5f6a7b8
Revises: b7c8d9e0f1a2
Create Date: 2026-07-06 16:00:00.000000

Hand-written: reports may now target a segment OR a replay (exactly one —
enforced by a check constraint), and users gain an is_admin flag for the
moderation queue. server_default keeps existing user rows valid; the reports
table is empty in every deployment so relaxing segment_id needs no backfill.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'c3d4e5f6a7b8'
down_revision: str | None = 'b7c8d9e0f1a2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'users',
        sa.Column(
            'is_admin', sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )
    op.add_column(
        'reports', sa.Column('replay_id', sa.String(length=36), nullable=True)
    )
    op.create_foreign_key(
        op.f('fk_reports_replay_id_replays'), 'reports', 'replays',
        ['replay_id'], ['id'],
    )
    op.create_index(op.f('ix_reports_replay_id'), 'reports', ['replay_id'])
    op.alter_column(
        'reports', 'segment_id', existing_type=sa.String(length=36), nullable=True
    )
    op.create_check_constraint(
        'one_target', 'reports', '(segment_id IS NULL) != (replay_id IS NULL)'
    )


def downgrade() -> None:
    op.drop_constraint(op.f('ck_reports_one_target'), 'reports', type_='check')
    op.execute('DELETE FROM reports WHERE segment_id IS NULL')
    op.alter_column(
        'reports', 'segment_id', existing_type=sa.String(length=36), nullable=False
    )
    op.drop_index(op.f('ix_reports_replay_id'), table_name='reports')
    op.drop_constraint(
        op.f('fk_reports_replay_id_replays'), 'reports', type_='foreignkey'
    )
    op.drop_column('reports', 'replay_id')
    op.drop_column('users', 'is_admin')
