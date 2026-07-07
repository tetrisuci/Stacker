"""PUT /segments/{id}/vote: auth gating, one-row-per-(user,segment) upsert,
Wilson-score ranking under sort=top, and my_vote in reads."""

from app.auth import SESSION_COOKIE, issue_session_token
from app.models import User, Vote
from app.segments import wilson_lower_bound

from .test_catalog import add_replay, add_segment


def put_vote(client, segment_id: str, value: int):
    return client.put(f"/segments/{segment_id}/vote", json={"value": value})


def test_vote_requires_auth(client, db_session):
    seg = add_segment(db_session, add_replay(db_session, 0), 0)
    assert put_vote(client, seg.id, 1).status_code == 401


def test_vote_upsert_and_clear(auth_client, db_session):
    seg = add_segment(db_session, add_replay(db_session, 0), 0)

    up = put_vote(auth_client, seg.id, 1).json()
    assert (up["ups"], up["downs"], up["myVote"]) == (1, 0, 1)
    assert up["score"] == wilson_lower_bound(1, 0) > 0

    # Voting the same way again stays a single row.
    again = put_vote(auth_client, seg.id, 1).json()
    assert (again["ups"], again["downs"]) == (1, 0)

    # Switching moves the row, not adds one.
    down = put_vote(auth_client, seg.id, -1).json()
    assert (down["ups"], down["downs"], down["myVote"]) == (0, 1, -1)

    # value 0 clears the vote entirely.
    cleared = put_vote(auth_client, seg.id, 0).json()
    assert (cleared["ups"], cleared["downs"], cleared["myVote"]) == (0, 0, 0)
    assert cleared["score"] == 0.0

    assert put_vote(auth_client, "nope", 1).status_code == 404
    assert put_vote(auth_client, seg.id, 5).status_code == 422


def test_wilson_ranking_beats_ratio(auth_client, db_session):
    replay = add_replay(db_session, 0)
    attested = add_segment(db_session, replay, 0)  # will be 20 up / 2 down
    lucky = add_segment(db_session, replay, 1)  # will be 1 up / 0 down

    # 19 ups + 2 downs from other users; the endpoint's recompute then sees
    # 20/2 once the authed user adds theirs.
    for i in range(21):
        voter = User(username=f"voter{i}")
        db_session.add(voter)
        db_session.flush()
        db_session.add(
            Vote(segment_id=attested.id, user_id=voter.id, value=1 if i < 19 else -1)
        )
    db_session.flush()
    assert put_vote(auth_client, attested.id, 1).json()["ups"] == 20
    assert put_vote(auth_client, lucky.id, 1).json()["ups"] == 1

    # Ratio (0.91 vs 1.0) and recency would both rank `lucky` first; the
    # Wilson lower bound ranks the well-attested segment first.
    top = auth_client.get("/segments", params={"sort": "top"}).json()
    assert [s["title"] for s in top["items"]] == ["segment 0", "segment 1"]
    scores = [s["score"] for s in top["items"]]
    assert scores == [wilson_lower_bound(20, 2), wilson_lower_bound(1, 0)]
    assert scores[0] > scores[1]

    new = auth_client.get("/segments", params={"sort": "new"}).json()
    assert [s["title"] for s in new["items"]] == ["segment 1", "segment 0"]

    # Keyset pagination under sort=top.
    first = auth_client.get("/segments", params={"sort": "top", "limit": 1}).json()
    assert [s["title"] for s in first["items"]] == ["segment 0"]
    rest = auth_client.get(
        "/segments", params={"sort": "top", "limit": 1, "cursor": first["nextCursor"]}
    ).json()
    assert [s["title"] for s in rest["items"]] == ["segment 1"]


def test_my_vote_in_reads(client, db_session, current_user):
    seg = add_segment(db_session, add_replay(db_session, 0), 0)

    # Anonymous reads report no vote.
    assert client.get(f"/segments/{seg.id}").json()["myVote"] == 0

    client.cookies.set(SESSION_COOKIE, issue_session_token(current_user.id))
    put_vote(client, seg.id, -1)
    assert client.get(f"/segments/{seg.id}").json()["myVote"] == -1
    listed = client.get("/segments").json()["items"]
    assert listed[0]["myVote"] == -1
