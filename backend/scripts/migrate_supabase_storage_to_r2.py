"""Copy Supabase Storage objects to Cloudflare R2 without deleting the source.

The logical buckets keep their current names, but are stored as prefixes:

    public R2 bucket  : audio/*, covers/*
    private R2 bucket : chapter-text/*, epub-uploads/*

After every selected object copies successfully, public cover/audio URLs in
Postgres are changed to R2 URLs. Private object paths do not need DB changes.
The script is idempotent: destination objects with the same size are skipped.

Configure both the existing SUPABASE_* variables and the new R2_* variables,
then run from backend/:

    python -m scripts.migrate_supabase_storage_to_r2          # dry run
    python -m scripts.migrate_supabase_storage_to_r2 --apply --skip-url-update
    python -m scripts.migrate_supabase_storage_to_r2 --apply  # final sync + URL cutover

Run during a maintenance window, or rerun immediately before deployment, so a
write cannot land in Supabase after its bucket has already been copied.
"""
import argparse
import logging
import mimetypes
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import httpx
from botocore.exceptions import ClientError
from storage3 import SyncStorageClient
from storage3.utils import StorageException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings
from app.database import get_client
from app.services import storage_service as r2

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("migrate_supabase_storage_to_r2")

BUCKETS = ("chapter-text", "covers", "epub-uploads", "audio")
PAGE = 1000
WAVE = 200
DEFAULT_WORKERS = 2
SOURCE_MAX_ATTEMPTS = 10
RETRYABLE_SOURCE_STATUSES = {408, 425, 429, 500, 502, 503, 504}


def _source_storage() -> SyncStorageClient:
    headers = {
        "apiKey": settings.supabase_service_key,
        "Authorization": f"Bearer {settings.supabase_service_key}",
    }
    return SyncStorageClient(
        f"{settings.supabase_url.rstrip('/')}/storage/v1/", headers
    )


def _source_http(max_connections: int) -> httpx.Client:
    return httpx.Client(
        base_url=f"{settings.supabase_url.rstrip('/')}/storage/v1",
        headers={
            "apiKey": settings.supabase_service_key,
            "Authorization": f"Bearer {settings.supabase_service_key}",
        },
        timeout=60.0,
        http2=False,
        limits=httpx.Limits(
            max_connections=max_connections,
            max_keepalive_connections=max_connections,
        ),
    )


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    if response is not None:
        retry_after = response.headers.get("Retry-After")
        if retry_after:
            try:
                return max(0.0, min(float(retry_after), 60.0))
            except ValueError:
                pass
    return min(2 ** (attempt - 1), 30) + random.uniform(0.0, 0.5)


def _download_source(source_http: httpx.Client, bucket: str, path: str) -> bytes:
    url = f"/object/{bucket}/{quote(path, safe='/')}"
    for attempt in range(1, SOURCE_MAX_ATTEMPTS + 1):
        response = None
        try:
            response = source_http.get(url)
            if response.status_code not in RETRYABLE_SOURCE_STATUSES:
                response.raise_for_status()
                return response.content
        except httpx.TransportError:
            if attempt == SOURCE_MAX_ATTEMPTS:
                raise
        else:
            if attempt == SOURCE_MAX_ATTEMPTS:
                response.raise_for_status()
        time.sleep(_retry_delay(response, attempt))
    raise RuntimeError(f"source download retry loop ended unexpectedly: {bucket}/{path}")


def _list_source(storage: SyncStorageClient, bucket: str, prefix: str, offset: int):
    for attempt in range(1, SOURCE_MAX_ATTEMPTS + 1):
        try:
            return storage.from_(bucket).list(
                prefix,
                {
                    "limit": PAGE,
                    "offset": offset,
                    "sortBy": {"column": "name", "order": "asc"},
                },
            )
        except StorageException as exc:
            details = exc.args[0] if exc.args and isinstance(exc.args[0], dict) else {}
            status = int(details.get("statusCode") or 0)
            if status not in RETRYABLE_SOURCE_STATUSES or attempt == SOURCE_MAX_ATTEMPTS:
                raise
            time.sleep(_retry_delay(None, attempt))
    raise RuntimeError(f"source list retry loop ended unexpectedly: {bucket}/{prefix}")


def walk_source(storage: SyncStorageClient, bucket: str, prefix: str = "", depth: int = 0):
    """Yield (path, size, content_type) for every Supabase object."""
    if depth > 8:
        raise RuntimeError(f"Refusing to recurse deeper than 8 levels at {bucket}/{prefix}")
    offset = 0
    while True:
        entries = _list_source(storage, bucket, prefix, offset)
        if not entries:
            return
        for entry in entries:
            child = f"{prefix}/{entry['name']}" if prefix else entry["name"]
            if entry.get("id") is None:
                yield from walk_source(storage, bucket, child, depth + 1)
                continue
            metadata = entry.get("metadata") or {}
            content_type = (
                metadata.get("mimetype")
                or metadata.get("contentType")
                or mimetypes.guess_type(child)[0]
                or "application/octet-stream"
            )
            yield child, int(metadata.get("size") or 0), content_type
        if len(entries) < PAGE:
            return
        offset += PAGE


def _destination_sizes(bucket: str) -> dict[str, int]:
    """Load one logical destination bucket with paginated R2 list requests."""
    prefix = r2._object_key(bucket)
    paginator = r2._get_storage().get_paginator("list_objects_v2")
    sizes: dict[str, int] = {}
    for page in paginator.paginate(
        Bucket=r2._physical_bucket(bucket),
        Prefix=prefix,
    ):
        for item in page.get("Contents") or []:
            key = item["Key"]
            sizes[key[len(prefix):]] = int(item.get("Size") or 0)
    return sizes


def _already_copied(
    path: str,
    source_size: int,
    overwrite: bool,
    destination_sizes: dict[str, int],
) -> bool:
    if overwrite:
        return False
    destination_size = destination_sizes.get(path)
    return destination_size is not None and (
        not source_size or destination_size == source_size
    )


def _copy_one(
    source_http: httpx.Client,
    bucket: str,
    path: str,
    size: int,
    content_type: str,
    overwrite: bool,
    destination_sizes: dict[str, int],
) -> tuple[str, int]:
    if _already_copied(path, size, overwrite, destination_sizes):
        return "skipped", size
    data = _download_source(source_http, bucket, path)
    if size and len(data) != size:
        raise RuntimeError(f"source size changed while copying: listed={size}, downloaded={len(data)}")
    cache_control = "no-cache" if bucket == "chapter-text" else None
    if bucket in r2.PUBLIC_BUCKETS:
        cache_control = "public, max-age=31536000, immutable"
    r2._sync_upload(bucket, path, data, content_type, cache_control)
    return "copied", len(data)


def copy_bucket(
    storage: SyncStorageClient,
    source_http: httpx.Client,
    bucket: str,
    *,
    apply: bool,
    overwrite: bool,
    workers: int,
) -> tuple[int, int, int]:
    objects = list(walk_source(storage, bucket))
    total_bytes = sum(item[1] for item in objects)
    logger.info("%s: %s objects, %.1f MiB", bucket, f"{len(objects):,}", total_bytes / 1024 / 1024)
    if not apply:
        return 0, 0, 0

    destination_sizes = _destination_sizes(bucket) if not overwrite else {}
    logger.info(
        "%s: loaded %s existing R2 objects in one paginated inventory",
        bucket,
        f"{len(destination_sizes):,}",
    )
    copied = skipped = failed = 0
    for start in range(0, len(objects), WAVE):
        wave = objects[start:start + WAVE]
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(
                    _copy_one,
                    source_http,
                    bucket,
                    path,
                    size,
                    content_type,
                    overwrite,
                    destination_sizes,
                ): path
                for path, size, content_type in wave
            }
            for future in as_completed(futures):
                try:
                    status, _ = future.result()
                    if status == "copied":
                        copied += 1
                    else:
                        skipped += 1
                except Exception as exc:
                    failed += 1
                    logger.warning("FAIL %s/%s: %s", bucket, futures[future], exc)
        logger.info(
            "%s: %s/%s processed (%s copied, %s skipped, %s failed)",
            bucket,
            f"{min(start + WAVE, len(objects)):,}",
            f"{len(objects):,}",
            f"{copied:,}",
            f"{skipped:,}",
            f"{failed:,}",
        )
    return copied, skipped, failed


def _supabase_public_path(url: str, bucket: str) -> str | None:
    marker = f"/storage/v1/object/public/{bucket}/"
    path = urlsplit(url).path
    if marker not in path:
        return None
    return unquote(path.split(marker, 1)[1])


def _r2_object_exists(bucket: str, path: str) -> bool:
    try:
        r2._get_storage().head_object(
            Bucket=r2._physical_bucket(bucket), Key=r2._object_key(bucket, path)
        )
        return True
    except ClientError as exc:
        status = int((exc.response.get("ResponseMetadata") or {}).get("HTTPStatusCode") or 0)
        if status == 404 or (exc.response.get("Error") or {}).get("Code") in {"404", "NoSuchKey"}:
            return False
        raise


def update_public_urls(selected_buckets: set[str]) -> tuple[int, int]:
    """Cut public database URLs over only after all object copies succeeded."""
    db = get_client()
    covers_updated = audio_updated = 0

    if "covers" in selected_buckets:
        offset = 0
        while True:
            rows = (
                db.table("books").select("id,cover_url").order("id")
                .range(offset, offset + PAGE - 1).execute().data or []
            )
            for row in rows:
                old_url = row.get("cover_url") or ""
                path = _supabase_public_path(old_url, "covers")
                if not path or not _r2_object_exists("covers", path):
                    continue
                query = f"?{urlsplit(old_url).query}" if urlsplit(old_url).query else ""
                db.table("books").update({
                    "cover_url": r2.public_url("covers", path) + query
                }).eq("id", row["id"]).execute()
                covers_updated += 1
            if len(rows) < PAGE:
                break
            offset += PAGE

    if "audio" in selected_buckets:
        offset = 0
        while True:
            rows = (
                db.table("chapters")
                .select("id,audio_url,audio_storage_path")
                .not_.is_("audio_url", "null").order("id")
                .range(offset, offset + PAGE - 1).execute().data or []
            )
            for row in rows:
                path = row.get("audio_storage_path") or _supabase_public_path(
                    row.get("audio_url") or "", "audio"
                )
                if not path or not _r2_object_exists("audio", path):
                    continue
                db.table("chapters").update({
                    "audio_url": r2.public_url("audio", path)
                }).eq("id", row["id"]).execute()
                audio_updated += 1
            if len(rows) < PAGE:
                break
            offset += PAGE

    return covers_updated, audio_updated


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="copy objects and update public URLs")
    parser.add_argument(
        "--skip-url-update",
        action="store_true",
        help="copy objects but leave existing Supabase public URLs unchanged",
    )
    parser.add_argument("--overwrite", action="store_true", help="upload even when destination size matches")
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"parallel copies (default: {DEFAULT_WORKERS}; keep low to avoid Supabase rate limits)",
    )
    parser.add_argument("--buckets", nargs="+", choices=BUCKETS, default=list(BUCKETS))
    args = parser.parse_args()

    if args.workers < 1:
        parser.error("--workers must be at least 1")

    r2._require_r2_config()
    storage = _source_storage()
    source_http = _source_http(args.workers)
    failures = 0
    try:
        for bucket in args.buckets:
            _, _, failed = copy_bucket(
                storage,
                source_http,
                bucket,
                apply=args.apply,
                overwrite=args.overwrite,
                workers=args.workers,
            )
            failures += failed
    finally:
        source_http.close()

    if not args.apply:
        logger.info("DRY RUN complete. Re-run with --apply to copy objects.")
        return
    if failures:
        raise SystemExit(
            f"Migration copied with {failures} failure(s). Public URLs were not changed; rerun safely."
        )
    if args.skip_url_update:
        logger.info("Copy complete. Public database URLs were intentionally left unchanged.")
        logger.info("Rerun with --apply after deploying the R2-aware frontend/backend.")
        return
    covers, audio = update_public_urls(set(args.buckets))
    logger.info("Migration complete. Updated %s cover URLs and %s audio URLs.", covers, audio)
    logger.info("Supabase source objects were retained for rollback.")


if __name__ == "__main__":
    main()
