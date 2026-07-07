"""S3-compatible object storage via boto3 (MinIO in dev, any S3 in prod).

The `replays` bucket is created by the compose `minio-init` one-shot, so app
code can assume it exists. Routes take `Storage` as a FastAPI dependency
(get_storage) so tests can substitute an in-memory fake.
"""

from functools import lru_cache
from typing import Any

import boto3

from .config import get_settings


@lru_cache
def get_s3_client() -> Any:
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint_url,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        region_name=s.s3_region,
    )


def replay_key(sha256: str) -> str:
    """Object key for a replay's bytes, addressed by content hash."""
    return f"replays/{sha256}.ttr"


class Storage:
    """Thin wrapper over the S3 client, scoped to the configured bucket."""

    def __init__(self, client: Any, bucket: str) -> None:
        self._client = client
        self._bucket = bucket

    def put_replay(self, sha256: str, raw: bytes) -> str:
        key = replay_key(sha256)
        self._client.put_object(
            Bucket=self._bucket,
            Key=key,
            Body=raw,
            ContentType="application/json",
        )
        return key

    def put_thumbnail(self, segment_id: str, raw: bytes) -> str:
        key = f"thumbnails/{segment_id}.png"
        self._client.put_object(
            Bucket=self._bucket,
            Key=key,
            Body=raw,
            ContentType="image/png",
        )
        return key

    def get_replay(self, storage_key: str):
        """Stream a stored replay's bytes (an iterator of chunks). We stream
        through the API rather than hand out presigned URLs because in dev
        those would point at the in-network MinIO hostname."""
        obj = self._client.get_object(Bucket=self._bucket, Key=storage_key)
        return obj["Body"].iter_chunks()

    def get_thumbnail(self, storage_key: str):
        """Stream a segment thumbnail's PNG bytes (same shape as get_replay)."""
        obj = self._client.get_object(Bucket=self._bucket, Key=storage_key)
        return obj["Body"].iter_chunks()


def get_storage() -> Storage:
    return Storage(get_s3_client(), get_settings().s3_bucket)
