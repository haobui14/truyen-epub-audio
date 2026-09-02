"""Repair duplicate chapter numbers in a scrape_wikidich download.

wikidichvn books routinely carry mislabeled chapters: a chapter whose URL/
heading says "chương N" but which physically sits at a different position
(digit-swap typos, renumbered blocks). scrape_wikidich files chapters by their
URL number, so such a chapter collides with the real N — two files share a
4-digit prefix, and the mislabeled one would merge into the wrong reading
position. The same books also repost a chapter verbatim under two URLs.

This tool fixes both, using the walk map scrape_wikidich persisted:

1. Near-identical dup pair (similarity > 0.9) → delete one file (verbatim
   repost).
2. Otherwise the pair is a mislabel. The map holds the LAST-walked URL for the
   number — the detour. Fetch that page once: its heading identifies which
   file is the detour, and its prev/next links bracket its true position. The
   detour is renamed into the unique free gap number inside the bracket, and
   the number in its heading line is corrected to match. The slot is verified
   against a neighbour's own prev/next link before anything is renamed;
   anything ambiguous (no unique gap in the bracket, heading matches neither
   file) is reported for manual handling instead of guessed at.

Gaps that pair with no duplicate are the site's own numbering skips — content
is continuous through them; they are reported and left alone.

Dry-run by default. Usage (from backend/):
    python -m scripts.repair_wikidich_dups work/aibaohan
    python -m scripts.repair_wikidich_dups work/aibaohan --apply
"""
import argparse
import collections
import difflib
import json
import logging
import re
import sys
import time
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
logger = logging.getLogger("repair_wikidich_dups")

CHAPTER_NUM_RE = re.compile(r"/chuong-(\d+)-")
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "vi,en;q=0.8",
}

import unicodedata


def slugify(text: str, max_len: int = 40) -> str:
    """Must stay identical to scrape_wikidich.slugify — filenames match on it."""
    text = text.replace("đ", "d").replace("Đ", "D")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return text[:max_len].rstrip("-") or "chuong"


def fetch_page(client: httpx.Client, url: str) -> BeautifulSoup:
    r = client.get(url)
    r.raise_for_status()
    time.sleep(0.6)
    return BeautifulSoup(r.text, "lxml")


def page_facts(soup: BeautifulSoup) -> tuple[str, int | None, int | None]:
    """(heading, prev_label, next_label) of a chapter page."""
    h = soup.select_one("h2.current-chapter")
    heading = h.get_text(strip=True) if h else ""
    p = m = None
    back = soup.select_one("#vungdoc a.back") or soup.select_one("a.back")
    nxt = soup.select_one("#vungdoc a.next") or soup.select_one("a.next")
    if back and (mb := CHAPTER_NUM_RE.search(back.get("href", ""))):
        p = int(mb.group(1))
    if nxt and (mn := CHAPTER_NUM_RE.search(nxt.get("href", ""))):
        m = int(mn.group(1))
    return heading, p, m


def link_label(soup: BeautifulSoup, side: str) -> int | None:
    el = soup.select_one(f"#vungdoc a.{side}") or soup.select_one(f"a.{side}")
    if el and (mm := CHAPTER_NUM_RE.search(el.get("href", ""))):
        return int(mm.group(1))
    return None


def run(workdir: Path, apply: bool) -> None:
    vi = workdir / "vi"
    map_path = workdir / "wikidich_map.json"
    if not vi.is_dir() or not map_path.exists():
        raise SystemExit(f"{workdir} lacks vi/ or wikidich_map.json — not a scrape_wikidich output")
    chap_map = {int(k): v for k, v in json.loads(map_path.read_text(encoding="utf-8")).items()}

    by_num: dict[int, list[Path]] = collections.defaultdict(list)
    for f in sorted(vi.glob("*.txt")):
        by_num[int(f.name[:4])].append(f)
    dups = {n: v for n, v in by_num.items() if len(v) > 1}
    nums = sorted(by_num)
    gaps = sorted(set(range(nums[0], nums[-1] + 1)) - set(by_num))
    logger.info(f"{sum(len(v) for v in by_num.values())} files, "
                f"{len(dups)} duplicated number(s) {sorted(dups)}, gaps {gaps}")
    if not dups:
        logger.info("nothing to repair")
        return

    deletes: list[Path] = []
    renames: list[tuple[Path, Path, int, int]] = []  # src, dst, old_label, slot
    manual: list[str] = []

    with httpx.Client(headers=HEADERS, timeout=30, follow_redirects=True) as client:
        for n, pair in sorted(dups.items()):
            if len(pair) != 2:
                manual.append(f"{n}: {len(pair)} files — handle by hand")
                continue
            a, b = pair
            ratio = difflib.SequenceMatcher(
                None, a.read_text(encoding="utf-8"), b.read_text(encoding="utf-8")
            ).ratio()
            if ratio > 0.9:
                logger.info(f"  {n}: verbatim repost (similarity {ratio:.3f}) — dropping {b.name}")
                deletes.append(b)
                continue

            url = chap_map.get(n)
            if not url:
                manual.append(f"{n}: no map URL")
                continue
            soup = fetch_page(client, url)
            heading, p, m = page_facts(soup)
            slug = slugify(heading)
            detour = [f for f in pair if f.name == f"{n:04d}_{slug}.txt"]
            if len(detour) != 1:
                manual.append(f"{n}: heading {heading[:40]!r} matches "
                              f"{len(detour)} of the two files")
                continue
            slot_choices = [g for g in gaps if p is not None and m is not None and p < g < m]
            if len(slot_choices) != 1:
                manual.append(f"{n}: bracket ({p}, {m}) has {len(slot_choices)} free gap(s) "
                              f"{slot_choices} — not unique")
                continue
            slot = slot_choices[0]

            # Verify against a neighbour's own link before renaming: the page
            # right after the slot must point back at label n, or the one
            # before it must point forward at label n.
            ok = False
            if (slot + 1) in chap_map:
                ok = link_label(fetch_page(client, chap_map[slot + 1]), "back") == n
            if not ok and (slot - 1) in chap_map:
                ok = link_label(fetch_page(client, chap_map[slot - 1]), "next") == n
            if not ok:
                manual.append(f"{n}: slot {slot} failed neighbour verification")
                continue

            gaps.remove(slot)
            renames.append((detour[0], vi / f"{slot:04d}_{slug}.txt", n, slot))
            logger.info(f"  {n}: detour {heading[:45]!r} bracket ({p}, {m}) → slot {slot} [verified]")

    logger.info("\nplan:")
    for f in deletes:
        logger.info(f"  delete  {f.name}")
    for src, dst, old, slot in renames:
        logger.info(f"  move    {src.name} -> {dst.name}  (heading Chương {old} -> Chương {slot})")
    for m in manual:
        logger.warning(f"  MANUAL  {m}")
    logger.info(f"remaining gaps (site numbering skips): {gaps}")

    if not apply:
        logger.info("\nDRY RUN — re-run with --apply to perform")
        return
    for f in deletes:
        f.unlink()
    for src, dst, old, slot in renames:
        text = src.read_text(encoding="utf-8")
        first, _, rest = text.partition("\n")
        fixed = re.sub(rf"^Chương\s+0*{old}\b", f"Chương {slot}", first)
        if fixed == first:
            logger.warning(f"  heading of {src.name} did not start with 'Chương {old}' — left as-is")
        src.write_text(fixed + "\n" + rest, encoding="utf-8")
        src.rename(dst)

    counts = collections.Counter(f.name[:4] for f in vi.glob("*.txt"))
    left = [k for k, c in counts.items() if c > 1]
    logger.info(f"\napplied. files={sum(counts.values())}, remaining dup prefixes={left or 'none'}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("workdir", help="scrape_wikidich output dir (contains vi/ + wikidich_map.json)")
    ap.add_argument("--apply", action="store_true", help="perform deletes/renames (default: dry-run)")
    args = ap.parse_args()
    run(Path(args.workdir), args.apply)


if __name__ == "__main__":
    main()
