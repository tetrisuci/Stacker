"""Keyset (cursor) pagination over (timestamp desc, id desc).

Offset pagination skips/duplicates rows as new uploads land; keyset pins the
page boundary to the last row seen. The cursor is an opaque base64 of
"<iso timestamp>|<id>"; ties on the timestamp are broken by id.
"""

import base64
import binascii
from datetime import datetime


def encode_cursor(ts: datetime, row_id: str) -> str:
    return base64.urlsafe_b64encode(f"{ts.isoformat()}|{row_id}".encode()).decode()


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    """Raises ValueError on garbage input (routes map it to 422)."""
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        ts_str, sep, row_id = raw.partition("|")
        if not sep or not row_id:
            raise ValueError("malformed cursor")
        return datetime.fromisoformat(ts_str), row_id
    except (binascii.Error, UnicodeDecodeError) as e:
        raise ValueError("malformed cursor") from e


def encode_top_cursor(score: float, ts: datetime, row_id: str) -> str:
    """Cursor for sort=top: (score desc, timestamp desc, id desc)."""
    return base64.urlsafe_b64encode(
        f"{score!r}|{ts.isoformat()}|{row_id}".encode()
    ).decode()


def decode_top_cursor(cursor: str) -> tuple[float, datetime, str]:
    """Raises ValueError on garbage input (routes map it to 422)."""
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        score_str, sep, rest = raw.partition("|")
        ts_str, sep2, row_id = rest.partition("|")
        if not sep or not sep2 or not row_id:
            raise ValueError("malformed cursor")
        return float(score_str), datetime.fromisoformat(ts_str), row_id
    except (binascii.Error, UnicodeDecodeError) as e:
        raise ValueError("malformed cursor") from e
