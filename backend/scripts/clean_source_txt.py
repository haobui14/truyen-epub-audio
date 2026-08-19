"""Clean a pirate-site .txt dump before splitting it into chapters.

Books scraped from sites like QiSuWang arrive wrapped in boilerplate that makes
a naive chapter split produce hundreds of near-empty chapters:

    ------------            <- separator rule
    第一章 【白痴】          <- title, spaced
    恶魔法则                <- book title
    （收藏，砸票！）          <- author's plea for votes
    第一章【白痴】           <- the SAME title again, unspaced
    <the actual chapter>

Every chapter heading appears twice, so the splitter opens a chapter on the
first one, finds only boilerplate before the second, and emits an empty file.
On 恶魔法则 that produced 337 chapters under 200 characters.

This collapses each run of consecutive headings that share a chapter NUMBER
down to the last one — the number is the reliable signal, because the two title
lines are not always textually identical (第九章【若琳的计划】 vs
第九章【若琳的色诱计划】). Boilerplate lines between them are dropped.

Dry run by default; --apply writes the cleaned UTF-8 file.

Usage (from backend/):
    python -m scripts.clean_source_txt book.txt -o clean.txt
    python -m scripts.clean_source_txt book.txt -o clean.txt --apply
"""
import argparse
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("clean_source")

ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "big5", "utf-16")
INDENT = "　﻿\xa0"

CN_NUM = "零一二三四五六七八九十百千两0-9０-９"
HEADING_RE = re.compile(rf"^第\s*([{CN_NUM}]{{1,12}})\s*[章回节節]")
# Horizontal rules and the site's own upload markers.
RULE_RE = re.compile(r"^[-=_*—]{4,}$")
BOILERPLATE_RE = re.compile(
    r"(奇书网|QiSuWang|用户上传|本站只提供|电子书存储|免费下载服务|"
    r"txt全集下载|TXT全集|请砸票|砸票|求收藏|收藏，|推荐票|月票|打赏|"
    r"新书需要支持|恳求收藏)"
)
# Stray HTML entities left by the scraper (&#183; &#8226; …).
ENTITY_RE = re.compile(r"^&#\d+[;；]?$")
# A heading block holding less text than this is boilerplate, not a chapter —
# real chapters here run ~4,000 characters, the junk blocks 0-200.
MERGE_BODY_CHARS = 400


def read_text(path: Path, forced: str | None) -> tuple[str, str]:
    raw = path.read_bytes()
    for enc in ((forced,) if forced else ENCODINGS):
        try:
            return raw.decode(enc), enc
        except (UnicodeDecodeError, LookupError):
            continue
    raise SystemExit(f"Could not decode {path.name}; pass --encoding")


# The scraper sometimes runs a heading straight into the first paragraph:
#   恶魔法则第八十三章【梅杜莎的考验】,,身为一名魔法师,尤其是...
# Left alone, that line is far too long for the splitter's heading check, so the
# chapter's text is swallowed by the PREVIOUS chapter and the standalone heading
# further down becomes an empty file. 101 lines in 恶魔法则 look like this, which
# is where its 34 heading-only chapters came from. Split them back apart.
GLUED_RE = re.compile(
    rf"^(第\s*[{CN_NUM}]{{1,12}}\s*[章回节節][^】\n]{{0,6}}(?:【[^】]*】)?)[,，、\s]*(\S.*)$"
)
# Below this the trailing text is part of the title, not a stolen paragraph.
GLUED_MIN_BODY = 15


def split_glued_heading(line: str) -> tuple[str, str] | None:
    """Return (heading, body) when a heading has body text welded onto it."""
    m = GLUED_RE.match(line)
    if not m:
        return None
    head, rest = m.group(1).strip(), m.group(2).strip()
    if len(rest) < GLUED_MIN_BODY:
        return None
    return head, rest


def normalize_heading(line: str, book_title: str | None) -> str:
    """Strip scraper decoration so heading variants compare equal.

    The same chapter shows up as "第八十三章【…】" and as
    "恶魔法则第八十三章【…】,," — book title glued to the front, stray commas at
    the end. Unless these normalise to one form the dedup below cannot tell they
    are the same chapter, and both survive as separate files.
    """
    s = line.strip()
    if book_title and s.startswith(book_title):
        rest = s[len(book_title) :].lstrip()
        if HEADING_RE.match(rest):
            s = rest
    return re.sub(r"[,，、\s]+$", "", s)


def heading_number(line: str) -> str | None:
    m = HEADING_RE.match(line.strip())
    return re.sub(r"\s+", "", m.group(1)) if m else None


def clean(text: str, book_title: str | None) -> tuple[str, dict]:
    lines = [l.strip().strip(INDENT).strip() for l in text.splitlines()]
    stats = {"rules": 0, "boilerplate": 0, "entities": 0, "title_lines": 0, "dup_headings": 0}

    kept: list[str] = []
    for line in lines:
        if not line:
            kept.append("")
            continue
        if RULE_RE.match(line):
            stats["rules"] += 1
            continue
        if ENTITY_RE.match(line):
            stats["entities"] += 1
            continue
        if book_title and line == book_title:
            stats["title_lines"] += 1
            continue
        # Fold "恶魔法则第八十三章【…】,," down to "第八十三章【…】" so the dedup
        # below sees it as the same chapter as the plain form.
        norm = normalize_heading(line, book_title)
        if norm != line and heading_number(norm):
            stats["title_lines"] += 1
            line = norm
        # Un-weld "第八十三章【…】,,身为一名魔法师…" into two lines so the splitter
        # can see the heading. Otherwise the body is lost to the prior chapter.
        glued = split_glued_heading(line)
        if glued:
            stats["glued"] = stats.get("glued", 0) + 1
            kept.append(glued[0])
            kept.append(glued[1])
            continue
        # Only drop short boilerplate lines — a long paragraph that happens to
        # mention 月票 is story text (characters do discuss such things).
        #
        # A CHAPTER HEADING IS NEVER BOILERPLATE. This author appends vote pleas
        # to the heading itself ("第八十九章【…】（求推荐票）"), so filtering by
        # keyword alone deleted 156 whole chapters — the heading vanished and its
        # body was absorbed into the previous chapter. Check the heading first.
        if heading_number(line) is None and len(line) <= 40 and BOILERPLATE_RE.search(line):
            stats["boilerplate"] += 1
            continue
        kept.append(line)

    # Rejoin headings the scraper broke across lines mid-bracket:
    #     第两百三十七章 【双赢
    #     】（双倍月票…）
    # The splitter sees only the first fragment, so the chapter's real text is
    # absorbed by the previous chapter and a stub file is emitted. Accounted for
    # 21 of the thin chapters in 恶魔法则.
    # NOTE: an attempt to rejoin these split headings was reverted. Merging the
    # following lines into the heading swallowed real paragraphs — coverage fell
    # from 667/668 chapters to 661 and 69,000 characters of body text vanished.
    # The 15-21 affected chapters keep a stub heading instead, which is visible
    # and harmless; losing text is neither. Fix by hand if it matters.

    # Collapse repeated headings for the same chapter number. The two title
    # lines are usually NOT adjacent — an author's aside sits between them
    # ("（六千字长章节，加量不加价～）"), so a strict adjacency check misses most
    # of them. Work on heading→body blocks instead: when a block carries almost
    # no text and the next heading repeats its number, the block is boilerplate
    # and the real chapter is the one that follows.
    idx = [n for n, l in enumerate(kept) if heading_number(l) is not None]
    drop_lines: set[int] = set()
    for a, start in enumerate(idx):
        end = idx[a + 1] if a + 1 < len(idx) else len(kept)
        body = "".join(kept[start + 1 : end]).strip()
        if len(body) >= MERGE_BODY_CHARS:
            continue
        num = heading_number(kept[start])
        # The heading is repeated BOTH before the chapter and again after it, so
        # an empty block is boilerplate whether its twin sits ahead of it or
        # behind it. Looking only forward left every trailing repeat behind as an
        # empty chapter.
        nxt = heading_number(kept[idx[a + 1]]) if a + 1 < len(idx) else None
        prv = heading_number(kept[idx[a - 1]]) if a > 0 else None
        if num in (nxt, prv):
            drop_lines.update(range(start, end))
            stats["dup_headings"] += 1
    out = [l for n, l in enumerate(kept) if n not in drop_lines]

    # Normalise blank runs.
    text_out = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip() + "\n"
    return text_out, stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--encoding", help="force an input encoding (default: autodetect)")
    ap.add_argument("--book-title", help="drop lines equal to this (the repeated title line)")
    ap.add_argument("--apply", action="store_true", help="write the file (default: dry run)")
    args = ap.parse_args()

    src = Path(args.source)
    if not src.is_file():
        raise SystemExit(f"No such file: {src}")
    text, enc = read_text(src, args.encoding)
    logger.info(f"read {src.name} ({len(text):,} chars) as {enc}")

    cleaned, stats = clean(text, args.book_title)
    heads_before = sum(1 for l in text.splitlines() if heading_number(l.strip().strip(INDENT)))
    heads_after = sum(1 for l in cleaned.splitlines() if heading_number(l))
    logger.info(
        f"removed: {stats['rules']} rule(s), {stats['boilerplate']} boilerplate, "
        f"{stats['entities']} entity line(s), {stats['title_lines']} title line(s), "
        f"{stats['dup_headings']} duplicate heading(s)"
    )
    logger.info(f"headings {heads_before} -> {heads_after}")
    logger.info(f"chars {len(text):,} -> {len(cleaned):,}")

    if not args.apply:
        logger.info("DRY RUN — nothing written. Re-run with --apply.")
        return
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(cleaned, encoding="utf-8")
    logger.info(f"wrote {out}")


if __name__ == "__main__":
    main()
