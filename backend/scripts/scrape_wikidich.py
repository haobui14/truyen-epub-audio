"""Download a book from wikidichvn.com into per-chapter .txt files.

Give it the BOOK page URL (the page with the DANH SÁCH tab). Chapters are
discovered by walking each chapter's "next" link — the site's own
/get/listchap endpoint only serves the first 200 chapters (pages 3+ come back
empty), so enumerate-then-fetch is not an option. Walking costs nothing extra:
every chapter page has to be fetched for its content anyway.

Output follows the split_book_chapters naming convention (0001_slug.txt,
chapter heading as the first line, blank-line paragraphs) so the usual tail of
the pipeline just works:

    scrape → merge_chapters → upload via admin UI

Dry run is the default: it fetches only the book page and reports what it
would download. --apply downloads the chapters.

Resumable: the chapter-number → URL map is persisted next to the output dir
(wikidich_map.json) as the walk progresses. A re-run first fills in any
missing files by direct URL from the map, then continues the walk from the
furthest known chapter. Existing non-empty files are never re-downloaded.

Polite by design: one request at a time, ~1s apart. Do not lower --delay to
hammer the site — ~950 chapters at 1s is ~25 minutes, just let it run.

Usage (from backend/):
    python -m scripts.scrape_wikidich https://wikidichvn.com/he-thong-hac-khoa-ky-quan-net -o work/quannet
    python -m scripts.scrape_wikidich <book-url> -o work/quannet --apply
    python -m scripts.scrape_wikidich <book-url> -o work/quannet --apply --limit 3   # smoke test
"""
import argparse
import json
import logging
import random
import re
import sys
import time
import unicodedata
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("scrape_wikidich")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "vi,en;q=0.8",
}

CHAPTER_NUM_RE = re.compile(r"/chuong-(\d+)-")

# Site boilerplate injected between story lines. Conservative on purpose —
# anything that survives is caught later by the upload sanitizer
# (app/services/text_cleanup.py). The Galaxy Play promo block appeared in 435
# chapters of one book (two uniform lines, spliced mid-scene).
JUNK_LINE_RE = re.compile(
    r"wikidich|đọc\s+truyện\s+tại|nguồn\s*:\s*http|https?://\S+$"
    r"|tặng\s*bạn\s*gói\s*xem\s*phim|galaxy\s*play|^nhận\s*quà\s*ngay\s*!?$",
    re.IGNORECASE,
)


def slugify(text: str, max_len: int = 40) -> str:
    text = text.replace("đ", "d").replace("Đ", "D")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return text[:max_len].rstrip("-") or "chuong"


def fetch(client: httpx.Client, url: str, tries: int = 3) -> httpx.Response:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            r = client.get(url)
            if r.status_code == 200:
                return r
            last = RuntimeError(f"HTTP {r.status_code}")
        except httpx.HTTPError as e:
            last = e
        time.sleep(2 + 3 * attempt)
    raise RuntimeError(f"{url}: {last}")


def book_info(client: httpx.Client, book_url: str) -> tuple[str, str, str, int]:
    """Returns (origin, book_title, first_chapter_url, last_chapter_number)."""
    r = fetch(client, book_url)
    origin = re.match(r"https?://[^/]+", str(r.url)).group(0)
    soup = BeautifulSoup(r.text, "lxml")
    title_el = soup.find("h1") or soup.find("title")
    book_title = title_el.get_text(strip=True) if title_el else book_url

    numbered: dict[int, str] = {}
    for a in soup.find_all("a", href=True):
        m = CHAPTER_NUM_RE.search(a["href"])
        if m:
            numbered.setdefault(int(m.group(1)), a["href"])
    if not numbered:
        raise SystemExit("No chapter links on the book page — check the URL")
    first = numbered[min(numbered)]
    if not first.startswith("http"):
        first = origin + first
    return origin, book_title, first, max(numbered)


def extract_chapter(html: str) -> tuple[str, list[str], str | None]:
    """Returns (chapter_heading, paragraphs, next_url_or_None)."""
    soup = BeautifulSoup(html, "lxml")
    heading_el = soup.select_one("h2.current-chapter") or soup.find("title")
    heading = heading_el.get_text(strip=True) if heading_el else ""

    next_url = None
    nxt = soup.select_one("#vungdoc a.next") or soup.select_one("a.next")
    if nxt:
        href = nxt.get("href", "")
        if href and href not in ("#", "javascript:;") and "disabled" not in (nxt.get("class") or []):
            next_url = href

    body = soup.select_one("#vungdoc .truyen") or soup.find(id="vungdoc")
    if body is None:
        return heading, [], next_url
    # Nav arrows, chapter-list button, download button live inside the
    # container — only the text nodes are story.
    for el in body.find_all(["a", "button", "svg", "script", "style", "h1", "h2", "span"]):
        el.decompose()
    paragraphs = []
    for line in body.get_text("\n").split("\n"):
        line = line.strip()
        if line and not JUNK_LINE_RE.search(line):
            paragraphs.append(line)
    # Many chapters repeat their own heading as the first body line (404 of
    # 1365 in one book). The heading is already the file's first line — keep
    # the copy and it renders twice everywhere downstream.
    if paragraphs and heading:
        hm = re.match(r"Chương\s+0*(\d+)\s*[:.]", heading, re.IGNORECASE)
        pm = re.match(r"Chương\s+0*(\d+)\s*[:.]", paragraphs[0], re.IGNORECASE)
        if hm and pm and hm.group(1).lstrip("0") == pm.group(1).lstrip("0"):
            paragraphs.pop(0)
    return heading, paragraphs, next_url


def chapter_path(out_dir: Path, num: int, title: str, pad: int) -> Path:
    return out_dir / f"{num:0{pad}d}_{slugify(title)}.txt"


def save_map(map_path: Path, chap_map: dict[int, str]) -> None:
    map_path.write_text(
        json.dumps({str(k): v for k, v in sorted(chap_map.items())}, ensure_ascii=False, indent=0),
        encoding="utf-8",
    )


def download_one(client: httpx.Client, out_dir: Path, num: int, url: str, pad: int) -> str | None:
    """Fetch one chapter, write its file unless it already exists.
    Returns the next-chapter URL (regardless of whether the file was written)."""
    r = fetch(client, url)
    heading, paragraphs, next_url = extract_chapter(r.text)
    path = chapter_path(out_dir, num, heading or f"chuong {num}", pad)
    if not (path.exists() and path.stat().st_size > 0):
        text = "\n\n".join([heading or f"Chương {num}"] + paragraphs).strip() + "\n"
        if len(text) < 200:
            raise RuntimeError(f"suspiciously short ({len(text)} chars) — not writing")
        path.write_text(text, encoding="utf-8")
    return next_url


def run(book_url: str, out_dir: Path, apply: bool, delay: float, limit: int | None) -> None:
    with httpx.Client(headers=HEADERS, timeout=30, follow_redirects=True) as client:
        origin, book_title, first_url, last_num = book_info(client, book_url)
        logger.info(f"book: {book_title}")
        logger.info(f"last chapter on the book page: {last_num}")
        logger.info(f"walk starts at: {first_url}")

        todo_total = min(limit, last_num) if limit else last_num
        if not apply:
            logger.info(
                f"\nDRY RUN — would walk ~{todo_total} chapter(s) into {out_dir}/ "
                f"(0001_slug.txt style, resumable via wikidich_map.json).\n"
                f"Re-run with --apply to download (~{todo_total * (delay + 0.4) / 60:.0f} min)."
            )
            return

        out_dir.mkdir(parents=True, exist_ok=True)
        pad = max(4, len(str(last_num)))
        map_path = out_dir.parent / "wikidich_map.json"
        chap_map: dict[int, str] = {}
        if map_path.exists():
            chap_map = {int(k): v for k, v in json.loads(map_path.read_text(encoding="utf-8")).items()}
            logger.info(f"resume: {len(chap_map)} chapter URL(s) already mapped")

        done = skipped = failed = 0
        fetched = 0
        t0 = time.time()

        def pace() -> None:
            time.sleep(delay + random.uniform(0, 0.4))

        def progress(done_num: int) -> None:
            if fetched and fetched % 25 == 0:
                rate = fetched / max(1e-9, time.time() - t0)
                eta = (todo_total - done_num) / max(rate, 1e-9)
                logger.info(
                    f"  chương {done_num}/{todo_total} (new {done}, skip {skipped}, fail {failed})"
                    f" — eta {eta / 60:.0f} min"
                )

        # Pass 1 — known URLs from a previous run: fill in missing files only.
        for num in sorted(chap_map):
            if limit and num > limit:
                break
            path_guess = list(out_dir.glob(f"{num:0{pad}d}_*.txt"))
            if path_guess and path_guess[0].stat().st_size > 0:
                skipped += 1
                continue
            try:
                download_one(client, out_dir, num, chap_map[num], pad)
                done += 1
                fetched += 1
                progress(num)
            except Exception as e:
                failed += 1
                logger.warning(f"  FAILED chương {num}: {e}")
            pace()

        # Pass 2 — continue the walk from the furthest known chapter.
        if chap_map:
            walk_num = max(chap_map)
            walk_url: str | None = chap_map[walk_num]
        else:
            walk_num = int(CHAPTER_NUM_RE.search(first_url).group(1))
            walk_url = first_url
            chap_map[walk_num] = walk_url

        while walk_url and (not limit or walk_num <= limit):
            existing = list(out_dir.glob(f"{walk_num:0{pad}d}_*.txt"))
            had_file = bool(existing and existing[0].stat().st_size > 0)
            try:
                next_url = download_one(client, out_dir, walk_num, walk_url, pad)
                fetched += 1
                if had_file:
                    skipped += 1
                else:
                    done += 1
            except Exception as e:
                failed += 1
                logger.warning(f"  FAILED chương {walk_num}: {e} — walk cannot continue past it")
                break
            progress(walk_num)
            if not next_url:
                break
            if not next_url.startswith("http"):
                next_url = origin + next_url
            m = CHAPTER_NUM_RE.search(next_url)
            next_num = int(m.group(1)) if m else walk_num + 1
            if next_num in chap_map and chap_map[next_num] == next_url:
                logger.warning(f"  next link loops back to chương {next_num} — stopping")
                break
            if next_num > last_num + 50:
                logger.warning(f"  next link jumped to {next_num} (> {last_num + 50}) — stopping")
                break
            walk_num, walk_url = next_num, next_url
            chap_map[walk_num] = walk_url
            if len(chap_map) % 10 == 0:
                save_map(map_path, chap_map)
            pace()

        save_map(map_path, chap_map)
        files = len(list(out_dir.glob("*.txt")))
        logger.info(f"\nnew {done}, skipped {skipped}, failed {failed} — {files} chapter file(s) in {out_dir}")
        if files < todo_total or failed:
            logger.info("re-run the same command to resume/retry (existing files are skipped)")
        else:
            logger.info(f"next: python -m scripts.merge_chapters {out_dir} -o {out_dir.parent / 'book.txt'}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("book_url", help="wikidichvn.com book page URL")
    ap.add_argument("-o", "--out", required=True,
                    help="output directory (e.g. work/quannet — chapters land in <out>/vi)")
    ap.add_argument("--apply", action="store_true", help="actually download (default: dry-run report)")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between chapter requests (default 1.0)")
    ap.add_argument("--limit", type=int, help="stop after chapter number N (smoke test)")
    args = ap.parse_args()

    out_dir = Path(args.out)
    if out_dir.name != "vi":
        out_dir = out_dir / "vi"
    run(args.book_url, out_dir, args.apply, max(args.delay, 0.5), args.limit)


if __name__ == "__main__":
    main()
