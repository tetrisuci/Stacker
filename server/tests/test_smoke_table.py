"""Prove the migration created the smoke table and that per-test rollback
isolation works: the second test must not see the first test's committed row.
(The pair is order-dependent by design — pytest runs them file-order.)"""

from sqlalchemy import func, select

from app.models import SmokeNote


def test_a_insert_and_commit(db_session):
    db_session.add(SmokeNote(note="hello from the test suite"))
    db_session.commit()  # releases a savepoint; outer transaction still rolls back

    count = db_session.scalar(select(func.count()).select_from(SmokeNote))
    assert count == 1


def test_b_previous_commit_was_rolled_back(db_session):
    count = db_session.scalar(select(func.count()).select_from(SmokeNote))
    assert count == 0
