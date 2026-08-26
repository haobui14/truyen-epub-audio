"""Full local backup: every Postgres table + every Storage bucket.

The library (71 books / ~114k chapters of translated, hand-cleaned text) lives
in one Supabase free-tier project with no point-in-time recovery, and the admin
tools include destructive bulk operations (strip-string, auto-split, reparse).
This script makes those safe: run it before risky operations and on a schedule.

  * DB tables    -> <dest>/db/<table>.json          (rewritten every run)
  * Storage      -> <dest>/storage/<bucket>/<path>  (incremental: existing
                    local files with matching size are skipped, so re-runs
                    only download what changed)

refresh_tokens is deliberately NOT dumped: session tokens on disk are a
liability and losing them merely logs everyone out.

Usage (from backend/):
    python -m scripts.backup_all                     # full backup to ./backups
    python -m scripts.backup_all --dest D:/backups/truyen
    python -m scripts.backup_all --skip-storage      # tables only (fast)
    python -m scripts.backup_all --buckets chapter-text
"""
import argparse
import json
import logging
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import get_client
from app.services import storage_service as ss

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per object is noise here
logger = logging.getLogger("backup_all")

# Table -> stable ordering column for range pagination.
TABLES = {
    "books": "id",
    "chapters": "id",
    "users": "id",
    "user_roles": "user_id",
    "user_progress": "id",
    "user_settings": "user_id",
    "user_stats": "user_id",
    "genres": "id",
    "book_genres": "book_id",
    "signup_log": "id",
    "client_log": "id",
}
BUCKETS = ["chapter-text", "covers", "epub-uploads"]
PAGE = 1000


def dump_tables(dest: Path) -> None:
    db = get_client()
    out_dir = dest / "db"
    out_dir.mkdir(parents=True, exist_ok=True)
    for table, order_col in TABLES.items():
        rows: list = []
        offset = 0
        try:
            while True:
                page = (
                    db.table(table)
                    .select("*")
                    .order(order_col)
                    .range(offset, offset + PAGE - 1)
                    .execute()
                )
                batch = page.data or []
                rows.extend(batch)
                if len(batch) < PAGE:
                    break
                offset += PAGE
        except Exception as e:
            # A table missing on an older schema must not sink the backup.
            logger.warning("table %s skipped: %s", table, e)
            continue
        path = out_dir / f"{table}.json"
        path.write_text(
            json.dumps(rows, ensure_ascii=False, default=str), encoding="utf-8"
        )
        logger.info("db/%s.json — %d rows", table, len(rows))


def walk_bucket(bucket: str, prefix: str = "", depth: int = 0):
    """Yield (path, size) for every object, recursing into folders (max 4 deep
    — legacy covers sit two levels down)."""
    if depth > 4:
        return
    offset = 0
    while True:
        entries = ss._sync_list(bucket, prefix, limit=PAGE, offset=offset)
        if not entries:
            break
        for e in entries:
            child = f"{prefix}/{e['name']}" if prefix else e["name"]
            if e.get("id") is None:  # folder
                yield from walk_bucket(bucket, child, depth + 1)
            else:
                yield child, int((e.get("metadata") or {}).get("size") or 0)
        if len(entries) < PAGE:
            break
        offset += PAGE


def _download(bucket: str, path: str) -> bytes:
    def _do() -> bytes:
        resp = ss._get_direct_client().get(f"/object/{bucket}/{path}")
        if resp.status_code >= 400:
            raise ss.StorageUploadError(resp.status_code, resp.text, bucket, path)
        return resp.content
    return ss._retry_sync(_do, what=f"download {bucket}/{path}")


def _fetch_one(bucket: str, path: str, local: Path) -> int:
    """Download one object to disk; returns byte count."""
    data = _download(bucket, path)
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_bytes(data)
    return len(data)


def mirror_bucket(bucket: str, dest: Path, workers: int = 8) -> None:
    """Incremental mirror. Chapter-text alone holds ~114k objects — serial
    downloads would take hours, so fan out on a small pool (8, matching
    storage_service.STORAGE_CONCURRENCY; the direct client is per-thread-safe
    httpx). Submitted in waves so the futures list stays bounded."""
    base = dest / "storage" / bucket
    downloaded = skipped = failed = 0
    dl_bytes = 0
    WAVE = 2000

    def flush(wave: list[tuple[str, Path]]) -> None:
        nonlocal downloaded, failed, dl_bytes
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(_fetch_one, bucket, path, local): path
                for path, local in wave
            }
            for fut in as_completed(futures):
                try:
                    dl_bytes += fut.result()
                    downloaded += 1
                except Exception as e:
                    logger.warning("FAIL %s/%s: %s", bucket, futures[fut], e)
                    failed += 1
                if downloaded and downloaded % 2000 == 0:
                    logger.info("%s: %d downloaded so far…", bucket, downloaded)

    wave: list[tuple[str, Path]] = []
    for path, size in walk_bucket(bucket):
        local = base / path
        if local.exists() and size and local.stat().st_size == size:
            skipped += 1
            continue
        wave.append((path, local))
        if len(wave) >= WAVE:
            flush(wave)
            wave = []
    if wave:
        flush(wave)
    logger.info(
        "storage/%s — %d downloaded (%.1f MB), %d unchanged, %d failed",
        bucket, downloaded, dl_bytes / 1024 / 1024, skipped, failed,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", default="backups", help="destination directory")
    parser.add_argument("--skip-db", action="store_true")
    parser.add_argument("--skip-storage", action="store_true")
    parser.add_argument(
        "--buckets", nargs="*", default=BUCKETS,
        help=f"buckets to mirror (default: {' '.join(BUCKETS)})",
    )
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    if not args.skip_db:
        dump_tables(dest)
    if not args.skip_storage:
        for bucket in args.buckets:
            mirror_bucket(bucket, dest, workers=args.workers)
    logger.info("Backup complete: %s", dest.resolve())


if __name__ == "__main__":
    main()
