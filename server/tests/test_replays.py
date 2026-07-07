"""POST /replays: ingest, dedup, Zenith parse-only, .ttrm rejection, caps.

Fixtures are synthesized minimal .ttr bodies mirroring the shapes the frontend
fixtures (src/replay/fixtures.ts) use, so the suite is hermetic — the real
sample files under test_data/ are git-ignored.
"""

import hashlib
import json

from app.ttr import MAX_REPLAY_BYTES


def make_ttr(
    *,
    gamemode: str = "40l",
    username: str = "promooooooo",
    bagtype: str | None = "7-bag",
    version: int | None = 1,
    stats: dict | None = None,
    extra_replay: dict | None = None,
) -> bytes:
    options: dict = {"seed": 1980741367}
    if bagtype is not None:
        options["bagtype"] = bagtype
    replay = {
        "frames": 916,
        "events": [
            {"type": "start", "data": {}, "frame": 0},
            {"type": "end", "data": {}, "frame": 916},
        ],
        "options": options,
        "results": {
            "aggregatestats": stats
            or {"pps": 3.78, "apm": 208.5, "vsscore": 369.87},
            "stats": {"piecesplaced": 101},
        },
        **(extra_replay or {}),
    }
    body: dict = {
        "gamemode": gamemode,
        "users": [{"username": username}],
        "replay": replay,
    }
    if version is not None:
        body["version"] = version
    return json.dumps(body).encode()


def upload(client, raw: bytes, filename: str = "run.ttr"):
    return client.post(
        "/replays",
        files={"file": (filename, raw, "application/json")},
    )


def test_40l_upload_stores_and_extracts(auth_client, fake_storage):
    raw = make_ttr()
    res = upload(auth_client, raw)
    assert res.status_code == 201, res.text
    body = res.json()

    assert body["playerUsername"] == "promooooooo"
    assert body["uploaderUsername"] == "zhiyuan"
    assert body["gamemode"] == "40l"
    assert body["seed"] == 1980741367
    assert body["bagtype"] == "7-bag"
    assert body["pps"] == 3.78
    assert body["apm"] == 208.5
    assert body["vsscore"] == 369.87
    assert body["frames"] == 916
    assert body["pieceCount"] == 101
    assert body["reconstructable"] is True
    assert body["reconstructableReason"] is None

    # Bytes live at replays/<sha256>.ttr.
    sha = hashlib.sha256(raw).hexdigest()
    assert body["fileHash"] == sha
    assert body["storageKey"] == f"replays/{sha}.ttr"
    assert fake_storage.objects[body["storageKey"]] == raw


def test_duplicate_upload_returns_200_existing(auth_client, fake_storage):
    raw = make_ttr()
    first = upload(auth_client, raw)
    assert first.status_code == 201
    again = upload(auth_client, raw)
    assert again.status_code == 200
    assert again.json()["id"] == first.json()["id"]
    # Dedup means no second parse/upload.
    assert fake_storage.put_count == 1


def test_zenith_is_stored_but_parse_only(auth_client, fake_storage):
    res = upload(auth_client, make_ttr(gamemode="zenith", bagtype="zenith"))
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["bagtype"] == "zenith"
    assert body["reconstructable"] is False
    assert "Zenith" in body["reconstructableReason"]
    assert fake_storage.put_count == 1  # stored despite being parse-only


def test_unsupported_bag_is_stored_but_not_reconstructable(auth_client):
    res = upload(auth_client, make_ttr(bagtype="bombs"))
    assert res.status_code == 201
    body = res.json()
    assert body["reconstructable"] is False
    assert 'bag type "bombs"' in body["reconstructableReason"]


def test_ttrm_extension_rejected_before_parsing(auth_client, fake_storage):
    # Content is a perfectly valid solo body — the extension alone rejects it.
    res = upload(auth_client, make_ttr(), filename="league.TTRM")
    assert res.status_code == 415
    assert res.json()["detail"] == "multiplayer replays are not supported"
    assert fake_storage.put_count == 0


def test_ttrm_shape_rejected(auth_client, fake_storage):
    for marker in ({"rounds": []}, {"leaderboard": []}):
        raw = make_ttr(extra_replay=marker)
        res = upload(auth_client, raw, filename="sneaky.ttr")
        assert res.status_code == 415, res.text
        assert res.json()["detail"] == "multiplayer replays are not supported"
    assert fake_storage.put_count == 0


def test_oversized_rejected(auth_client, fake_storage):
    res = upload(auth_client, b"0" * (MAX_REPLAY_BYTES + 1))
    assert res.status_code == 413
    assert fake_storage.put_count == 0


def test_malformed_rejected(auth_client, fake_storage):
    assert upload(auth_client, b"not json {").status_code == 422
    not_a_replay = json.dumps({"hello": "world"}).encode()
    assert upload(auth_client, not_a_replay).status_code == 422
    # Replay body present but no options block.
    no_options = json.dumps({"gamemode": "40l", "replay": {"events": []}}).encode()
    assert upload(auth_client, no_options).status_code == 422
    assert fake_storage.put_count == 0
