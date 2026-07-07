"""POST /segments: auth gating, validation, tags (vocabulary + free),
thumbnail storage, and unverified hints."""

import json

from .test_catalog import add_replay

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

HINTS = {
    "boardMetrics": {"holes": 1, "bumpiness": 4, "aggregateHeight": 22},
    "pieces": 21,
    "clears": 8,
    "spins": 2,
}


def publish(client, replay_id: str, **overrides):
    data = {
        "replay_id": replay_id,
        "start_piece": 10,
        "end_piece": 30,
        "title": "clean DT into PC",
        "description": "textbook",
        "difficulty": 3,
        "tags": "dt-cannon, Perfect Clear Grind",
        "hints": json.dumps(HINTS),
    } | overrides
    files = {"thumbnail": ("thumb.png", PNG, "image/png")}
    return client.post("/segments", data=data, files=files)


def test_publish_requires_auth(client, db_session):
    replay = add_replay(db_session, 0)
    assert publish(client, replay.id).status_code == 401


def test_publish_segment(auth_client, db_session, fake_storage):
    replay = add_replay(db_session, 0)
    res = publish(auth_client, replay.id)
    assert res.status_code == 201, res.text
    body = res.json()

    assert body["replayId"] == replay.id
    assert body["startPiece"] == 10 and body["endPiece"] == 30
    assert body["authorUsername"] == "zhiyuan"
    assert body["difficulty"] == 3
    # Vocabulary tag matched by slug; free tag created as 'custom'.
    assert body["tagSlugs"] == ["dt-cannon", "perfect-clear-grind"]
    # Hints stored as submitted, and NOT verified.
    assert body["hints"] == HINTS
    assert body["verified"] is False
    assert body["status"] == "published"
    # Thumbnail landed in object storage under the segment id.
    assert body["thumbnailKey"] == f"thumbnails/{body['id']}.png"
    assert fake_storage.objects[body["thumbnailKey"]] == PNG

    # The free tag is now part of /tags with category custom.
    tags = {t["slug"]: t for t in auth_client.get("/tags").json()}
    assert tags["perfect-clear-grind"]["category"] == "custom"

    # And the segment is browsable.
    listed = auth_client.get("/segments").json()
    assert [s["id"] for s in listed["items"]] == [body["id"]]


def test_publish_validation(auth_client, db_session):
    replay = add_replay(db_session, 0)  # piece_count=101
    assert publish(auth_client, "nope").status_code == 404
    assert (
        publish(auth_client, replay.id, start_piece=50, end_piece=40).status_code
        == 422
    )
    assert (
        publish(auth_client, replay.id, end_piece=500).status_code == 422
    )
    assert publish(auth_client, replay.id, hints="not json").status_code == 422


def test_segment_thumbnail_streams_png(auth_client, db_session):
    replay = add_replay(db_session, 0)
    seg_id = publish(auth_client, replay.id).json()["id"]

    res = auth_client.get(f"/segments/{seg_id}/thumbnail")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"
    assert res.content == PNG

    # A segment published without a thumbnail 404s, as does an unknown id.
    bare = auth_client.post(
        "/segments",
        data={"replay_id": replay.id, "start_piece": 0, "end_piece": 5, "title": "x"},
    ).json()
    assert auth_client.get(f"/segments/{bare['id']}/thumbnail").status_code == 404
    assert auth_client.get("/segments/nope/thumbnail").status_code == 404


def test_publish_rejects_non_png_thumbnail(auth_client, db_session):
    replay = add_replay(db_session, 0)
    res = auth_client.post(
        "/segments",
        data={
            "replay_id": replay.id,
            "start_piece": 0,
            "end_piece": 5,
            "title": "x",
        },
        files={"thumbnail": ("thumb.png", b"GIF89a not a png", "image/png")},
    )
    assert res.status_code == 422
