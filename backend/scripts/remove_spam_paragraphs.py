"""Remove pirate-site watermark paragraphs from stored chapter text.

Vietnamese web-novel EPUBs from truyen.thichcode.net inject watermark lines,
obfuscated with random punctuation/spacing so naive string matching misses them:

    t-r,uy en .t h i chco de,.net
    t.ruyệ-n ,đư ợ c c op,y t.ạ i t-r,uy en .t h i chco de,.net
    download PRC mới nhất tại truyen.thichcode.net
    tr uyện được c.o-p y tạ,i- .tr,u.ye,n-.t,hi.c h,cod e . net

Detection: normalize each paragraph (strip Vietnamese diacritics, fold đ→d,
lowercase, drop everything that isn't a-z/0-9) and look for the signature token
"thichcode". Every obfuscation variant collapses to it; no regex arms race.

Rewrites objects in the chapter-text bucket in place ({book_id}/{chapter_id}.txt,
gzip, Content-Type application/gzip, NEVER Content-Encoding — mirrors
storage_service.upload_chapter_text). Also refreshes chapters.word_count for
modified chapters so the UI stays consistent.

Idempotent: a cleaned chapter has no matching paragraphs on re-run and is skipped.

Usage (from backend/):
    python -m scripts.remove_spam_paragraphs --book-id <id>            # dry run, one book
    python -m scripts.remove_spam_paragraphs --book-id <id> --apply
    python -m scripts.remove_spam_paragraphs                           # dry run, whole bucket
    python -m scripts.remove_spam_paragraphs --apply --workers 8
    python -m scripts.remove_spam_paragraphs --signature anothersite --apply
"""
import argparse
import logging
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Make `app.*` imports work when run as `python -m scripts.…`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import get_client
from app.services import storage_service as ss
from app.services.storage_service import CHAPTER_TEXT_BUCKET

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("remove_spam_paragraphs")

LIST_PAGE = 1000
CHUNK = 2000  # objects submitted to the pool per wave (bounds in-flight futures)
GZIP_MIME = "application/gzip"

# Core token(s) of the watermark after normalization. "thichcode" survives every
# obfuscation of truyen.thichcode.net because normalization removes exactly the
# junk (punctuation, spaces, diacritics) the spammer inserts.
DEFAULT_SIGNATURES = ("thichcode",)

_NOT_ALNUM_RE = re.compile(r"[^a-z0-9]+")


def _normalize(s: str) -> str:
    """Lowercase, strip diacritics (ệ→e, ợ→o, …), fold đ→d, drop non-alphanumerics."""
    s = s.replace("đ", "d").replace("Đ", "D")  # U+0111 has no NFD decomposition
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return _NOT_ALNUM_RE.sub("", s.lower())


def remove_spam_paragraphs(text: str, signatures: tuple[str, ...]) -> tuple[str, list[str]]:
    """Drop lines whose normalized form contains any signature.

    Chapter text is newline-delimited paragraphs (see text_cleaner.clean_text).
    Returns (new_text, removed_lines).
    """
    kept: list[str] = []
    removed: list[str] = []
    for line in text.split("\n"):
        norm = _normalize(line)
        if norm and any(sig in norm for sig in signatures):
            removed.append(line)
        else:
            kept.append(line)
    if not removed:
        return text, []
    new_text = "\n".join(kept)
    # Removing lines can leave 3+ consecutive newlines; collapse like clean_text does.
    new_text = re.sub(r"\n{3,}", "\n\n", new_text).strip()
    return new_text, removed


def _download_http1(path: str) -> bytes:
    """Download over the HTTP/1.1 upload client instead of storage3's shared
    HTTP/2 connection — same fix as compress_chapter_text.py (storage3 drops
    streams under concurrent fan-out on the shared HTTP/2 socket)."""
    def _do() -> bytes:
        resp = ss._get_upload_client().get(f"/object/{CHAPTER_TEXT_BUCKET}/{path}")
        if resp.status_code >= 400:
            raise ss.StorageUploadError(resp.status_code, resp.text, CHAPTER_TEXT_BUCKET, path)
        return resp.content
    return ss._retry_sync(_do, what=f"download {CHAPTER_TEXT_BUCKET}/{path}")


def list_objects(book_id: str | None):
    """Yield object paths in chapter-text (or one book's folder).

    Same two-level listing as compress_chapter_text.py: list root for {book_id}
    folders (folder entries have id == None), then page through each folder."""
    if book_id:
        folders = [book_id]
    else:
        folders = []
        offset = 0
        while True:
            entries = ss._sync_list(CHAPTER_TEXT_BUCKET, "", limit=LIST_PAGE, offset=offset)
            if not entries:
                break
            for e in entries:
                if e.get("id") is None:
                    folders.append(e["name"])
            if len(entries) < LIST_PAGE:
                break
            offset += LIST_PAGE

    for folder in folders:
        f_offset = 0
        while True:
            files = ss._sync_list(CHAPTER_TEXT_BUCKET, folder, limit=LIST_PAGE, offset=f_offset)
            if not files:
                break
            for f in files:
                if f.get("id") is None:
                    continue  # nested folder (not expected at this depth)
                yield f"{folder}/{f['name']}"
            if len(files) < LIST_PAGE:
                break
            f_offset += LIST_PAGE


def clean_one(path: str, signatures: tuple[str, ...], apply: bool):
    """Returns (status, removed_lines, new_word_count, error).
    status in {clean, empty, dry_run, cleaned, error}."""
    try:
        data = _download_http1(path)
        if len(data) == 0:
            return ("empty", [], None, None)
        if ss._is_gzip(data):
            data = ss._gunzip_decompress(data)
        text = data.decode("utf-8")

        new_text, removed = remove_spam_paragraphs(text, signatures)
        if not removed:
            return ("clean", [], None, None)

        new_word_count = len(new_text.split())
        if not apply:
            return ("dry_run", removed, new_word_count, None)
        gz = ss._gzip_compress(new_text.encode("utf-8"))
        ss._sync_upload(CHAPTER_TEXT_BUCKET, path, gz, GZIP_MIME)  # retried internally
        return ("cleaned", removed, new_word_count, None)
    except Exception as e:
        return ("error", [], None, f"{type(e).__name__}: {e}")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--apply", action="store_true", help="actually rewrite (default: dry run)")
    ap.add_argument("--book-id", help="process a single book folder")
    ap.add_argument("--workers", type=int, default=ss.STORAGE_CONCURRENCY,
                    help=f"concurrent workers (default {ss.STORAGE_CONCURRENCY})")
    ap.add_argument("--signature", action="append", default=[],
                    help="extra normalized signature token to match (repeatable)")
    args = ap.parse_args()

    signatures = DEFAULT_SIGNATURES + tuple(_normalize(s) for s in args.signature)
    logger.info(
        "Mode: %s | workers=%d | signatures=%s%s",
        "APPLY (rewriting)" if args.apply else "DRY RUN (report only)",
        args.workers, list(signatures),
        f" | book={args.book_id}" if args.book_id else "",
    )
    ss._get_storage()        # warm singletons before threads race for them
    ss._get_upload_client()

    logger.info("Enumerating objects…")
    objects = list(list_objects(args.book_id))
    total = len(objects)
    logger.info("Found %s objects.", f"{total:,}")
    if total == 0:
        return

    started = time.monotonic()
    done = n_hit = n_clean = n_empty = n_error = 0
    paragraphs_removed = 0
    # (chapter_id, new_word_count) for DB sync after apply
    wc_updates: list[tuple[str, int]] = []

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i in range(0, total, CHUNK):
            batch = objects[i:i + CHUNK]
            futures = {pool.submit(clean_one, p, signatures, args.apply): p for p in batch}
            for fut in as_completed(futures):
                path = futures[fut]
                status, removed, new_wc, err = fut.result()
                done += 1
                if status in ("cleaned", "dry_run"):
                    n_hit += 1
                    paragraphs_removed += len(removed)
                    if status == "cleaned":
                        # path is {book_id}/{chapter_id}.txt
                        wc_updates.append((Path(path).stem, new_wc))
                    for line in removed[:5]:
                        logger.info("  %s %s: %r",
                                    "removed" if status == "cleaned" else "would remove",
                                    path, line[:120])
                    if len(removed) > 5:
                        logger.info("  … and %d more in %s", len(removed) - 5, path)
                elif status == "clean":
                    n_clean += 1
                elif status == "empty":
                    n_empty += 1
                elif status == "error":
                    n_error += 1
                    logger.warning("  error %s: %s", path, err)

            elapsed = time.monotonic() - started
            rate = done / elapsed if elapsed else 0
            eta = (total - done) / rate if rate else 0
            logger.info(
                "Progress %s/%s | %.0f/s ETA %.1fm | hit=%s clean=%s empty=%s err=%s | paragraphs removed=%s",
                f"{done:,}", f"{total:,}", rate, eta / 60,
                f"{n_hit:,}", f"{n_clean:,}", f"{n_empty:,}", f"{n_error:,}",
                f"{paragraphs_removed:,}",
            )

    # Keep chapters.word_count consistent with the rewritten text.
    if wc_updates:
        logger.info("Updating word_count for %d chapters…", len(wc_updates))
        db = get_client()
        for chapter_id, wc in wc_updates:
            try:
                db.table("chapters").update({"word_count": wc}).eq("id", chapter_id).execute()
            except Exception as e:
                n_error += 1
                logger.warning("  word_count update failed for %s: %s", chapter_id, e)

    logger.info("-" * 60)
    logger.info(
        "%s: chapters hit=%s (paragraphs removed=%s) clean=%s empty=%s error=%s",
        "Would clean" if not args.apply else "Cleaned",
        f"{n_hit:,}", f"{paragraphs_removed:,}", f"{n_clean:,}", f"{n_empty:,}", f"{n_error:,}",
    )
    if not args.apply:
        logger.info("DRY RUN — pass --apply to rewrite.")
    logger.info("Done in %.1fm.", (time.monotonic() - started) / 60)


if __name__ == "__main__":
    main()
