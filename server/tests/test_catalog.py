"""Catalog reads: replay/segment filtering, keyset pagination, tags, files."""

from datetime import UTC, datetime, timedelta

from app.models import Replay, Segment, Tag, User

T0 = datetime(2026, 1, 1, tzinfo=UTC)


def add_replay(
    db,
    i: int,
    *,
    player: str = "promooooooo",
    mode: str = "40l",
    style: str | None = None,
    pps: float | None = None,
    apm: float | None = None,
) -> Replay:
    r = Replay(
        file_hash=f"{i:064d}",
        storage_key=f"replays/{i:064d}.ttr",
        size_bytes=100,
        filename=f"replay{i}.ttr",
        player_username=player,
        player_userid=None,
        gamemode=mode,
        seed=1,
        bagtype="7-bag",
        frames=916,
        pps=pps,
        apm=apm,
        piece_count=101,
        style=style,
        reconstructable=True,
        uploaded_at=T0 + timedelta(minutes=i),
    )
    db.add(r)
    db.flush()
    return r


def add_segment(
    db,
    replay: Replay,
    i: int,
    *,
    tags: list[str] = [],  # noqa: B006 — read-only default
    difficulty: int | None = None,
    status: str = "published",
    author: User | None = None,
) -> Segment:
    s = Segment(
        replay_id=replay.id,
        author=author,
        start_piece=0,
        end_piece=10,
        title=f"segment {i}",
        description="",
        difficulty=difficulty,
        status=status,
        created_at=T0 + timedelta(minutes=i),
        tags=[db.get(Tag, slug) for slug in tags],
    )
    db.add(s)
    db.flush()
    return s


# ---- GET /replays ----


def test_replay_filters(client, db_session):
    add_replay(db_session, 0, player="alice", mode="40l", style="sprint", pps=2.0)
    add_replay(db_session, 1, player="bob", mode="blitz", style="sprint", pps=3.5)
    add_replay(db_session, 2, player="alice", mode="blitz", style=None, pps=4.5)

    by_player = client.get("/replays", params={"player": "ALICE"}).json()
    assert [r["playerUsername"] for r in by_player["items"]] == ["alice", "alice"]

    by_mode = client.get("/replays", params={"mode": "blitz"}).json()
    assert {r["playerUsername"] for r in by_mode["items"]} == {"bob", "alice"}

    by_style = client.get("/replays", params={"style": "sprint"}).json()
    assert len(by_style["items"]) == 2

    by_pps = client.get(
        "/replays", params={"pps_min": 3.0, "pps_max": 4.0}
    ).json()
    assert [r["pps"] for r in by_pps["items"]] == [3.5]

    combined = client.get(
        "/replays", params={"player": "alice", "mode": "blitz"}
    ).json()
    assert len(combined["items"]) == 1


def test_replay_keyset_pagination(client, db_session):
    for i in range(5):
        add_replay(db_session, i)

    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        params = {"limit": 2} | ({"cursor": cursor} if cursor else {})
        page = client.get("/replays", params=params).json()
        seen += [r["id"] for r in page["items"]]
        pages += 1
        cursor = page["nextCursor"]
        if cursor is None:
            break

    assert pages == 3  # 2 + 2 + 1
    assert len(seen) == len(set(seen)) == 5
    # Newest first: minute offsets descend.
    filenames = [
        client.get(f"/replays/{rid}").json()["filename"] for rid in seen[:2]
    ]
    assert filenames == ["replay4.ttr", "replay3.ttr"]


def test_malformed_cursor_rejected(client):
    assert client.get("/replays", params={"cursor": "not-a-cursor"}).status_code == 422


def test_replay_detail_embeds_segments(client, db_session):
    replay = add_replay(db_session, 0)
    add_segment(db_session, replay, 0, tags=["tki"])
    other = add_replay(db_session, 1)
    add_segment(db_session, other, 1)

    body = client.get(f"/replays/{replay.id}").json()
    assert len(body["segments"]) == 1
    assert body["segments"][0]["tagSlugs"] == ["tki"]
    assert client.get("/replays/nope").status_code == 404


def test_replay_file_streams_bytes(client, db_session, fake_storage):
    replay = add_replay(db_session, 0)
    fake_storage.objects[replay.storage_key] = b'{"replay": true}'
    res = client.get(f"/replays/{replay.id}/file")
    assert res.status_code == 200
    assert res.content == b'{"replay": true}'
    assert "replay0.ttr" in res.headers["content-disposition"]


# ---- GET /segments ----


def test_segment_filters(client, db_session):
    forty = add_replay(db_session, 0, player="alice", mode="40l")
    blitz = add_replay(db_session, 1, player="bob", mode="blitz")
    add_segment(db_session, forty, 0, tags=["tki", "downstack"], difficulty=2)
    add_segment(db_session, forty, 1, tags=["tki"], difficulty=5)
    add_segment(db_session, blitz, 2, tags=["downstack"], difficulty=2)
    add_segment(db_session, blitz, 3, status="pending")  # never listed

    all_out = client.get("/segments").json()
    assert len(all_out["items"]) == 3  # pending hidden
    # Embedded replay summary present for one-request rendering.
    assert all_out["items"][0]["replay"]["playerUsername"] == "bob"

    both_tags = client.get(
        "/segments", params=[("tag", "tki"), ("tag", "downstack")]
    ).json()
    assert [s["title"] for s in both_tags["items"]] == ["segment 0"]

    by_mode = client.get("/segments", params={"mode": "blitz"}).json()
    assert [s["title"] for s in by_mode["items"]] == ["segment 2"]

    by_difficulty = client.get("/segments", params={"difficulty": 2}).json()
    assert {s["title"] for s in by_difficulty["items"]} == {"segment 0", "segment 2"}

    by_player = client.get("/segments", params={"player": "Alice"}).json()
    assert {s["title"] for s in by_player["items"]} == {"segment 0", "segment 1"}


def test_segment_replay_stat_filters(client, db_session):
    """Browse facets that live on the referenced replay: style + pps/apm."""
    fast = add_replay(db_session, 0, style="aggressive", pps=3.5, apm=120.0)
    slow = add_replay(db_session, 1, style="safe", pps=1.5, apm=40.0)
    add_segment(db_session, fast, 0)
    add_segment(db_session, slow, 1)

    by_style = client.get("/segments", params={"style": "aggressive"}).json()
    assert [s["title"] for s in by_style["items"]] == ["segment 0"]

    fast_pps = client.get("/segments", params={"pps_min": 2.0}).json()
    assert [s["title"] for s in fast_pps["items"]] == ["segment 0"]
    slow_pps = client.get("/segments", params={"pps_max": 2.0}).json()
    assert [s["title"] for s in slow_pps["items"]] == ["segment 1"]

    by_apm = client.get(
        "/segments", params={"apm_min": 100.0, "apm_max": 150.0}
    ).json()
    assert [s["title"] for s in by_apm["items"]] == ["segment 0"]

    # Range filters exclude replays with NULL stats.
    add_segment(db_session, add_replay(db_session, 2), 2)
    assert len(client.get("/segments", params={"pps_min": 0.0}).json()["items"]) == 2


def test_segment_pagination_newest_first(client, db_session):
    replay = add_replay(db_session, 0)
    for i in range(5):
        add_segment(db_session, replay, i)

    first = client.get("/segments", params={"limit": 3}).json()
    assert [s["title"] for s in first["items"]] == [
        "segment 4",
        "segment 3",
        "segment 2",
    ]
    rest = client.get(
        "/segments", params={"limit": 3, "cursor": first["nextCursor"]}
    ).json()
    assert [s["title"] for s in rest["items"]] == ["segment 1", "segment 0"]
    assert rest["nextCursor"] is None


def test_segment_detail(client, db_session):
    author = User(username="curator")
    db_session.add(author)
    replay = add_replay(db_session, 0)
    seg = add_segment(
        db_session, replay, 0, tags=["pc-setup"], difficulty=4, author=author
    )

    body = client.get(f"/segments/{seg.id}").json()
    assert body["title"] == "segment 0"
    assert body["tagSlugs"] == ["pc-setup"]
    assert body["difficulty"] == 4
    assert body["authorUsername"] == "curator"
    assert body["replay"]["id"] == replay.id
    assert body["startPiece"] == 0 and body["endPiece"] == 10
    assert client.get("/segments/nope").status_code == 404


# ---- GET /tags ----


def test_tag_vocabulary_seeded(client):
    tags = client.get("/tags").json()
    by_slug = {t["slug"]: t for t in tags}
    assert {"tki", "dt-cannon", "mko"} <= set(by_slug)
    assert {
        "downstack",
        "clean-4wide",
        "all-spin",
        "burst",
        "cheese-clear",
        "pc-setup",
    } <= set(by_slug)
    assert by_slug["tki"]["category"] == "opener"
    assert by_slug["downstack"]["category"] == "skill"
    assert by_slug["dt-cannon"]["label"] == "DT-cannon"
