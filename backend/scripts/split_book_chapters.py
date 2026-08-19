"""Split one big Chinese novel .txt into per-chapter .txt files.

Detects headings like 第一章 / 第1章 / 第三回 / 楔子 / 序章 at the start of a
short line, then writes one file per chapter plus a manifest.json that the
translate step reads.

Dry-run by default (prints what it found); pass --apply to actually write.

Usage (from backend/):
    python -m scripts.split_book_chapters book.txt -o out/cn
    python -m scripts.split_book_chapters book.txt -o out/cn --apply
    python -m scripts.split_book_chapters book.txt -o out/cn --encoding gb18030 --apply
"""
import argparse
import json
import logging
import re
import sys
from pathlib import Path

# The Windows console defaults to a legacy codepage and would print the Chinese
# headings as \uXXXX escapes — unreadable, and reviewing them is the whole point.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("split_book_chapters")

# Chinese web novels are usually UTF-8 or GB18030 (superset of GBK/GB2312).
# Order matters: gb18030 decodes almost any byte stream, so try strict UTF-8 first.
ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "big5", "utf-16")

CJK = r"一-鿿㐀-䶿"

# 第 + number (arabic / fullwidth / Chinese numerals) + unit
CHAPTER_RE = re.compile(
    r"第\s*[0-9０-９一二三四五六七八九十百千万萬零〇两兩廿卅]{1,12}\s*[章回節节]"
)
# Standalone front/back matter headings
SPECIAL_RE = re.compile(
    r"^(楔子|序章|序言|序幕|引子|前言|尾聲|尾声|終章|终章|後記|后记|番外.{0,20}|完本感言)\s*$"
)
# Volume markers — not chapters, but worth reporting so boundaries aren't a surprise
VOLUME_RE = re.compile(r"^第\s*[0-9０-９一二三四五六七八九十百千零〇两兩]{1,8}\s*[卷部集]")
# Opt-in: bare numbered headings like "0123 标题" or "123、标题"
LOOSE_RE = re.compile(r"^\d{1,4}\s*[、.．,:：]?\s*\S")

# Chinese paragraph indentation uses fullwidth spaces; strip them so the TTS
# pipeline never reads them and the translator doesn't waste tokens on them.
INDENT_CHARS = "　﻿\xa0"


def read_text(path: Path, forced: str | None) -> tuple[str, str]:
    raw = path.read_bytes()
    candidates = (forced,) if forced else ENCODINGS
    for enc in candidates:
        try:
            return raw.decode(enc), enc
        except (UnicodeDecodeError, LookupError):
            continue
    raise SystemExit(
        f"Could not decode {path.name}. Tried: {', '.join(candidates)}. "
        "Pass --encoding with the right codec."
    )


def is_heading(line: str, max_len: int, loose: bool) -> bool:
    s = line.strip().strip(INDENT_CHARS).strip()
    if not s or len(s) > max_len:
        return False
    m = CHAPTER_RE.search(s)
    # Require the marker near the line start so body text ("他翻到第三章…") is skipped.
    if m and m.start() <= 8:
        return True
    if SPECIAL_RE.match(s):
        return True
    if loose and LOOSE_RE.match(s):
        return True
    return False


def clean_line(line: str) -> str:
    return line.strip().strip(INDENT_CHARS).strip()


def clean_body(lines: list[str]) -> str:
    """One source line == one paragraph, emitted blank-line separated.

    Chinese web-novel .txt files put each paragraph on its own line (indented
    with fullwidth spaces) and usually have no blank line between them. The rest
    of this project — the reader, the TTS chunker and the translate step — all
    treat a blank line as the paragraph boundary, so normalise to that here.
    """
    return "\n\n".join(s for s in (clean_line(raw) for raw in lines) if s).strip()


def safe_filename(title: str, limit: int = 60) -> str:
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", title)
    s = re.sub(r"\s+", " ", s).strip()
    return (s[:limit] or "chuong").strip()


def split_book(
    src: Path,
    out_dir: Path,
    encoding: str | None,
    max_heading_len: int,
    loose: bool,
    apply: bool,
) -> None:
    text, used_enc = read_text(src, encoding)
    logger.info(f"Read {src.name} ({len(text):,} chars) as {used_enc}")

    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if is_heading(line, max_heading_len, loose)]
    volumes = [clean_line(l) for l in lines if VOLUME_RE.match(clean_line(l))]

    if not starts:
        raise SystemExit(
            "No chapter headings found. Try --loose, raise --max-heading-len, "
            "or check the encoding with --encoding."
        )

    chapters: list[dict] = []

    preamble = clean_body(lines[: starts[0]])
    if preamble:
        chapters.append({"heading": "前言", "body": preamble, "preamble": True})
        logger.warning(
            f"{len(preamble):,} chars before the first heading — kept as chapter 0001 (前言)"
        )

    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(lines)
        heading = clean_line(lines[start])
        chapters.append({"heading": heading, "body": clean_body(lines[start + 1 : end])})

    logger.info(f"Found {len(starts)} chapter headings, {len(chapters)} output files")
    if volumes:
        logger.info(
            f"{len(volumes)} volume marker(s) seen (kept inside chapter bodies): {volumes[:3]}"
        )

    logger.info("First 5 headings: %s", [c["heading"] for c in chapters[:5]])
    logger.info("Last 3 headings:  %s", [c["heading"] for c in chapters[-3:]])

    sizes = [len(c["body"]) for c in chapters]
    total = sum(sizes)
    logger.info(
        f"Body total {total:,} chars; min {min(sizes):,} / "
        f"median {sorted(sizes)[len(sizes) // 2]:,} / max {max(sizes):,}"
    )
    tiny = [c["heading"] for c, s in zip(chapters, sizes) if s < 200]
    huge = [c["heading"] for c, s in zip(chapters, sizes) if s > 20000]
    if tiny:
        logger.warning(f"{len(tiny)} chapter(s) under 200 chars — check these: {tiny[:5]}")
    if huge:
        logger.warning(
            f"{len(huge)} chapter(s) over 20k chars — a heading was probably missed: {huge[:5]}"
        )

    manifest = []
    for n, ch in enumerate(chapters, start=1):
        name = f"{n:04d}_{safe_filename(ch['heading'])}.txt"
        manifest.append(
            {
                "index": n,
                "file": name,
                "heading": ch["heading"],
                "chars": len(ch["body"]),
            }
        )

    if not apply:
        logger.info("DRY RUN — nothing written. Re-run with --apply once the headings look right.")
        for row in manifest[:5]:
            logger.info(f"  would write {row['file']} ({row['chars']:,} chars)")
        return

    out_dir.mkdir(parents=True, exist_ok=True)
    for ch, row in zip(chapters, manifest):
        # Heading stays as the first line so it gets translated with the body.
        content = f"{ch['heading']}\n\n{ch['body']}\n" if ch["body"] else f"{ch['heading']}\n"
        (out_dir / row["file"]).write_text(content, encoding="utf-8")
    (out_dir / "manifest.json").write_text(
        json.dumps(
            {"source": src.name, "encoding": used_enc, "chapters": manifest},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    logger.info(f"Wrote {len(manifest)} files + manifest.json to {out_dir}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="path to the full-book .txt")
    ap.add_argument("-o", "--out", required=True, help="output directory for chapter files")
    ap.add_argument("--encoding", help="force an encoding (default: autodetect)")
    ap.add_argument(
        "--max-heading-len",
        type=int,
        default=40,
        help="a line longer than this is never treated as a heading (default: 40)",
    )
    ap.add_argument(
        "--loose",
        action="store_true",
        help="also treat bare numbered lines ('123 标题') as headings",
    )
    ap.add_argument("--apply", action="store_true", help="actually write files (default: dry run)")
    args = ap.parse_args()

    src = Path(args.source)
    if not src.is_file():
        raise SystemExit(f"No such file: {src}")
    split_book(
        src,
        Path(args.out),
        args.encoding,
        args.max_heading_len,
        args.loose,
        args.apply,
    )


if __name__ == "__main__":
    sys.exit(main())
