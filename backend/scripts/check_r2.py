"""Smoke-test R2 credentials, both buckets, and the public media URL."""
import sys
import uuid
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import storage_service as storage


def main() -> None:
    suffix = uuid.uuid4().hex
    path = f"_migration-smoke/{suffix}.txt"
    payload = f"r2-smoke-{suffix}".encode()
    written: list[tuple[str, str]] = []
    try:
        for bucket in ("covers", "epub-uploads"):
            storage._sync_upload(bucket, path, payload, "text/plain", "no-store")
            written.append((bucket, path))
            assert storage._sync_download(bucket, path) == payload
            print(f"Authenticated R2 round trip passed: {bucket}")

        url = storage.public_url("covers", path)
        response = httpx.get(url, timeout=30, follow_redirects=True)
        response.raise_for_status()
        assert response.content == payload
        print("Public media URL passed")
    finally:
        for bucket, object_path in written:
            storage._sync_remove(bucket, [object_path])
        if written:
            print("Temporary smoke-test objects removed")


if __name__ == "__main__":
    main()
