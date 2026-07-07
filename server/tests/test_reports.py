"""Reports + moderation: filing against segments/replays, admin gating, the
status-driven hide/remove/restore lifecycle, and — the point of it all — that
a removed segment disappears from every public listing."""

from app.auth import SESSION_COOKIE, issue_session_token
from app.models import User

from .test_catalog import add_replay, add_segment

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def as_user(client, user: User):
    client.cookies.set(SESSION_COOKIE, issue_session_token(user.id))


def as_anon(client):
    client.cookies.delete(SESSION_COOKIE)


def test_report_requires_auth(client, db_session):
    seg = add_segment(db_session, add_replay(db_session, 0), 0)
    res = client.post(
        "/reports", json={"segmentId": seg.id, "reason": "stolen replay"}
    )
    assert res.status_code == 401


def test_report_targets(auth_client, db_session):
    replay = add_replay(db_session, 0)
    seg = add_segment(db_session, replay, 0)

    on_segment = auth_client.post(
        "/reports", json={"segmentId": seg.id, "reason": "wrong window"}
    )
    assert on_segment.status_code == 201, on_segment.text
    body = on_segment.json()
    assert body["segment"]["id"] == seg.id
    assert body["replay"] is None
    assert body["reporterUsername"] == "zhiyuan"

    on_replay = auth_client.post(
        "/reports", json={"replayId": replay.id, "reason": "botted run"}
    )
    assert on_replay.status_code == 201
    assert on_replay.json()["replay"]["id"] == replay.id
    assert on_replay.json()["segment"] is None

    # Exactly one target, and it must exist; reason has a floor.
    both = {"segmentId": seg.id, "replayId": replay.id, "reason": "both"}
    assert auth_client.post("/reports", json=both).status_code == 422
    assert (
        auth_client.post("/reports", json={"reason": "neither"}).status_code == 422
    )
    assert (
        auth_client.post(
            "/reports", json={"segmentId": "nope", "reason": "ghost"}
        ).status_code
        == 404
    )
    assert (
        auth_client.post(
            "/reports", json={"segmentId": seg.id, "reason": "x"}
        ).status_code
        == 422
    )


def test_admin_endpoints_gated(client, db_session, current_user):
    seg = add_segment(db_session, add_replay(db_session, 0), 0)

    assert client.get("/admin/reports").status_code == 401
    as_user(client, current_user)  # logged in, but not an admin
    assert client.get("/admin/reports").status_code == 403
    assert (
        client.post(
            f"/admin/segments/{seg.id}/moderate", json={"action": "remove"}
        ).status_code
        == 403
    )


def test_admin_queue_lists_reports(client, db_session, current_user, admin_user):
    replay = add_replay(db_session, 0)
    seg = add_segment(db_session, replay, 0)
    as_user(client, current_user)
    client.post("/reports", json={"segmentId": seg.id, "reason": "first"})
    client.post("/reports", json={"replayId": replay.id, "reason": "second"})

    as_user(client, admin_user)
    queue = client.get("/admin/reports").json()
    assert [r["reason"] for r in queue] == ["second", "first"]  # newest first
    assert queue[1]["segment"]["title"] == "segment 0"
    assert queue[0]["replay"]["filename"] == "replay0.ttr"


def test_removed_segment_disappears_from_public_listings(
    client, db_session, current_user, admin_user, fake_storage
):
    replay = add_replay(db_session, 0)
    seg = add_segment(db_session, replay, 0, tags=["tki"])
    keeper = add_segment(db_session, replay, 1)
    seg.thumbnail_key = f"thumbnails/{seg.id}.png"
    fake_storage.objects[seg.thumbnail_key] = PNG
    db_session.flush()

    # Baseline: on every public surface.
    assert {s["id"] for s in client.get("/segments").json()["items"]} == {
        seg.id,
        keeper.id,
    }
    assert client.get(f"/segments/{seg.id}").status_code == 200
    assert client.get(f"/segments/{seg.id}/thumbnail").status_code == 200
    assert len(client.get(f"/replays/{replay.id}").json()["segments"]) == 2

    as_user(client, admin_user)
    res = client.post(
        f"/admin/segments/{seg.id}/moderate", json={"action": "remove"}
    )
    assert res.status_code == 200 and res.json()["status"] == "removed"

    # Gone everywhere, for everyone.
    as_anon(client)
    for sort in ("new", "top"):
        listed = client.get("/segments", params={"sort": sort}).json()["items"]
        assert [s["id"] for s in listed] == [keeper.id]
    listed_tagged = client.get("/segments", params={"tag": "tki"}).json()["items"]
    assert listed_tagged == []
    assert client.get(f"/segments/{seg.id}").status_code == 404
    assert client.get(f"/segments/{seg.id}/thumbnail").status_code == 404
    embedded = client.get(f"/replays/{replay.id}").json()["segments"]
    assert [s["id"] for s in embedded] == [keeper.id]
    # Votes on it are refused too.
    as_user(client, current_user)
    assert (
        client.put(f"/segments/{seg.id}/vote", json={"value": 1}).status_code == 404
    )

    # hide behaves the same (recoverable), restore brings it all back.
    as_user(client, admin_user)
    client.post(f"/admin/segments/{keeper.id}/moderate", json={"action": "hide"})
    as_anon(client)
    assert client.get("/segments").json()["items"] == []

    as_user(client, admin_user)
    for target in (seg, keeper):
        client.post(
            f"/admin/segments/{target.id}/moderate", json={"action": "restore"}
        )
    as_anon(client)
    assert {s["id"] for s in client.get("/segments").json()["items"]} == {
        seg.id,
        keeper.id,
    }
    assert client.get(f"/segments/{seg.id}").status_code == 200
