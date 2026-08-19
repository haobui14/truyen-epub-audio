"""Remove a literal string (or regex match) from chapter text — one book or all.

Terminal twin of POST /api/books/{id}/strip-string, sharing its strip logic via
app.services.text_cleanup so a preview in the admin UI and a run here agree.
Use this instead of the admin UI when the job is big: the endpoint holds one
HTTP request open for the whole pass, and the library is ~114k chapters — that
is hours of Storage round-trips, well past any gateway timeout.

DRY-RUN by default: reports what would be removed, writes nothing.

Site watermarks are machine-translated per chapter, so one exact string
typically matches a tiny fraction of its own occurrences (one book carried 137
variants of a single promo line). Prefer --regex --whole-line, and always read
the dry-run sample before adding --apply.

Usage (from backend/):
    # preview one book, exact string
    python -m scripts.strip_string_from_book <book_id> "STRING"

    # preview every book, regex, delete the whole line that matches
    python -m scripts.strip_string_from_book all "dtv[\\s\\-_]*ebook" \\
        --regex --whole-line --manifest dtv.json

    # apply, touching only the chapters the preview found (much faster)
    python -m scripts.strip_string_from_book all "dtv[\\s\\-_]*ebook" \\
        --regex --whole-line --manifest dtv.json --state dtv.done --apply

--state appends each chapter id as it lands, and skips those ids if you run the
same command again — a killed run resumes instead of restarting.
"""
import argparse
import asyncio
import collections
import json
import logging
import re
import sys
import time
from pathlib import Path

# Make `app.*` imports work when run as `python -m scripts.…`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import get_client
from app.services import storage_service, text_cleanup

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
# A book whose text objects were cleaned up logs one warning per chapter, which
# buries the progress lines. Missing text is already counted in the summary.
logging.getLogger("app.services.storage_service").setLevel(logging.ERROR)
logger = logging.getLogger("strip_string_from_book")

PAGE_SIZE = 1000


def _load_chapters(db, book_id: str) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        page = (
            db.table("chapters")
            .select("id,chapter_index,updated_at")
            .eq("book_id", book_id)
            .order("chapter_index")
            .range(offset, offset + PAGE_SIZE - 1)
            .execute()
        )
        batch = page.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


async def run(args: argparse.Namespace) -> None:
    db = get_client()
    try:
        pattern = text_cleanup.build_pattern(args.target, args.regex)
    except re.error as e:
        raise SystemExit(f"Invalid regex: {e}")

    if args.book_id == "all":
        books = db.table("books").select("id,title").order("created_at").execute().data or []
    else:
        book = (
            db.table("books").select("id,title").eq("id", args.book_id).maybe_single().execute()
        )
        if not book or not book.data:
            raise SystemExit(f"Book {args.book_id} not found")
        books = [book.data]

    titles = {b["id"]: b["title"] for b in books}

    # An apply run driven by a manifest only re-reads the chapters a previous
    # dry run flagged — the difference between minutes and hours on 114k rows.
    manifest_ids: set[str] | None = None
    if args.manifest and args.apply and Path(args.manifest).exists():
        raw = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
        manifest_ids = {entry[1] for entry in raw}
        logger.info(f"manifest: restricting to {len(manifest_ids)} chapters")

    done_ids: set[str] = set()
    state_file = None
    if args.state:
        sp = Path(args.state)
        if sp.exists():
            done_ids = {ln.strip() for ln in sp.read_text(encoding="utf-8").splitlines() if ln.strip()}
            logger.info(f"state: skipping {len(done_ids)} chapters finished earlier")
        state_file = sp.open("a", encoding="utf-8")

    targets: list[tuple[str, dict]] = []
    for b in books:
        for ch in _load_chapters(db, b["id"]):
            if ch["id"] in done_ids:
                continue
            if manifest_ids is not None and ch["id"] not in manifest_ids:
                continue
            targets.append((b["id"], ch))

    mode = "APPLY" if args.apply else "DRY RUN"
    logger.info(
        f"[{mode}] {len(targets)} chapters across {len(books)} book(s), "
        f"target={args.target!r} regex={args.regex} whole_line={args.whole_line}"
    )
    if not targets:
        logger.info("nothing to do")
        return

    sem = asyncio.Semaphore(args.concurrency)
    samples: collections.Counter = collections.Counter()
    per_book: collections.Counter = collections.Counter()
    hit_manifest: list[list] = []
    counters = {"done": 0, "matched": 0, "occurrences": 0, "written": 0, "failed": 0, "missing": 0}
    t0 = time.time()

    async def strip_one(book_id: str, ch: dict) -> None:
        async with sem:
            try:
                text = await storage_service.get_chapter_text_by_ids(
                    book_id, ch["id"], ch.get("updated_at")
                )
                if not text:
                    counters["missing"] += 1
                    return
                new_text, hits, removed = text_cleanup.apply_strip(
                    text, pattern, args.whole_line
                )
                if hits:
                    counters["matched"] += 1
                    counters["occurrences"] += hits
                    per_book[titles.get(book_id, book_id)] += hits
                    hit_manifest.append([book_id, ch["id"], hits])
                    for r in removed:
                        samples[r] += 1
                if hits and args.apply:
                    new_word_count = len(new_text.split()) if new_text.strip() else 0
                    path = await storage_service.upload_chapter_text(
                        book_id, ch["id"], new_text
                    )
                    await asyncio.to_thread(
                        lambda: db.table("chapters").update({
                            "text_storage_path": path,
                            "word_count": new_word_count,
                        }).eq("id", ch["id"]).execute()
                    )
                    counters["written"] += 1
                    if state_file:
                        state_file.write(ch["id"] + "\n")
                        state_file.flush()
            except Exception as e:
                # One bad chapter must not end the run — record and move on.
                counters["failed"] += 1
                logger.warning(f"chapter {ch['id']} failed: {type(e).__name__}: {e}")
            finally:
                counters["done"] += 1
                if counters["done"] % 2000 == 0:
                    el = time.time() - t0
                    left = (len(targets) - counters["done"]) * el / counters["done"] / 60
                    logger.info(
                        f"  {counters['done']}/{len(targets)} "
                        f"matched={counters['matched']} written={counters['written']} "
                        f"failed={counters['failed']} — {el/60:.1f}m elapsed, ~{left:.0f}m left"
                    )

    try:
        await asyncio.gather(*(strip_one(bid, ch) for bid, ch in targets))
    finally:
        if state_file:
            state_file.close()

    logger.info(
        f"[{mode}] scanned {counters['done']}, matched {counters['matched']} chapters "
        f"({counters['occurrences']} occurrences), wrote {counters['written']}, "
        f"failed {counters['failed']}, no stored text {counters['missing']} "
        f"— {(time.time() - t0) / 60:.1f} min"
    )
    if per_book:
        logger.info("per book:")
        for title, n in per_book.most_common():
            logger.info(f"  {n:7d}  {title}")
    if samples:
        logger.info(f"sample of removed text ({len(samples)} distinct):")
        for s, n in samples.most_common(15):
            logger.info(f"  {n:6d}x {s!r}")

    if args.manifest and not args.apply:
        Path(args.manifest).write_text(json.dumps(hit_manifest), encoding="utf-8")
        logger.info(f"manifest written: {args.manifest} ({len(hit_manifest)} chapters)")
    if not args.apply and counters["matched"]:
        logger.info("DRY RUN — re-run with --apply to remove the text above.")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("book_id", help="UUID of the book, or 'all' for every book")
    ap.add_argument("target", help="literal string, or regex with --regex")
    ap.add_argument("--regex", action="store_true", help="treat target as a regex (case-insensitive)")
    ap.add_argument("--whole-line", action="store_true", help="delete the entire line containing a match")
    ap.add_argument("--apply", action="store_true", help="actually write (default: dry run)")
    ap.add_argument(
        "--concurrency", type=int, default=storage_service.STORAGE_CONCURRENCY,
        help="parallel Storage ops (default 8; reads tolerate ~12)",
    )
    ap.add_argument("--manifest", help="dry run: write hits here; apply: only touch chapters listed here")
    ap.add_argument("--state", help="append finished chapter ids here and skip them on re-run (resume)")
    args = ap.parse_args()
    if not args.target:
        raise SystemExit("target string cannot be empty")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
