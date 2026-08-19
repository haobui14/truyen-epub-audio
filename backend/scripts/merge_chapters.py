"""Merge a directory of per-chapter .txt files into one book .txt.

The counterpart to scripts.split_book_chapters: takes the folder of translated
chapters and concatenates them, in filename order, into a single UTF-8 file.

Filename order is the chapter order — split_book_chapters writes a zero-padded
index prefix (0001_, 0002_, …) precisely so a plain sort is correct. Gaps are
fine and expected once unwanted chapters have been deleted; they are reported
so a missing chapter can't slip by unnoticed.

Each chapter keeps its own heading as the first line, separated from the next by
a blank line, so the result matches the layout the rest of this project treats
as paragraph-per-blank-line.

Refuses to overwrite an existing output unless --force.

Usage (from backend/):
    python -m scripts.merge_chapters work/xuanjian/vi -o work/xuanjian/book.txt
    python -m scripts.merge_chapters work/xuanjian/vi -o book.txt --force
"""
import argparse
import logging
import re
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("merge_chapters")

INDEX_RE = re.compile(r"^(\d+)_")


def merge(in_dir: Path, out_path: Path, force: bool, separator: str) -> None:
    files = sorted(in_dir.glob("*.txt"))
    if not files:
        raise SystemExit(f"No .txt files in {in_dir}")
    if out_path.exists() and not force:
        raise SystemExit(f"{out_path} already exists — pass --force to overwrite")
    # Never read the output back in as a chapter if it lives in the same folder.
    files = [f for f in files if f.resolve() != out_path.resolve()]

    indices = []
    for f in files:
        m = INDEX_RE.match(f.name)
        if m:
            indices.append(int(m.group(1)))
    if indices:
        missing = sorted(set(range(min(indices), max(indices) + 1)) - set(indices))
        logger.info(
            f"index range {min(indices):04d}..{max(indices):04d}, "
            f"{len(files)} file(s), {len(missing)} gap(s)"
        )
        if missing:
            shown = ", ".join(str(i) for i in missing[:20])
            logger.info(f"  gaps (deleted chapters): {shown}{' …' if len(missing) > 20 else ''}")
    else:
        logger.warning("no numeric index prefixes found — falling back to plain filename order")

    parts, empty = [], []
    for f in files:
        body = f.read_text(encoding="utf-8").strip()
        if not body:
            empty.append(f.name)
            continue
        parts.append(body)
    if empty:
        logger.warning(f"skipped {len(empty)} empty file(s): {empty[:5]}")

    text = separator.join(parts) + "\n"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")

    kb = out_path.stat().st_size / 1024
    logger.info(
        f"wrote {out_path} — {len(parts):,} chapter(s), {len(text):,} chars, {kb / 1024:.1f} MB"
    )
    logger.info(f"  first line: {text.splitlines()[0][:60]}")
    logger.info(f"  last line:  {text.strip().splitlines()[-1][:60]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("directory", help="directory of per-chapter .txt files")
    ap.add_argument("-o", "--out", required=True, help="output .txt path")
    ap.add_argument("--force", action="store_true", help="overwrite an existing output file")
    ap.add_argument(
        "--separator",
        default="\n\n",
        help="text placed between chapters (default: one blank line)",
    )
    args = ap.parse_args()

    d = Path(args.directory)
    if not d.is_dir():
        raise SystemExit(f"No such directory: {d}")
    merge(d, Path(args.out), args.force, args.separator)


if __name__ == "__main__":
    main()
