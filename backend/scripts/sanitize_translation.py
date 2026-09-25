"""Sanitize translated Vietnamese chapters for the TTS pipeline.

The translation step is good but not perfect at scale. This cleans up what it
leaves behind, in three passes:

  1. Markup    — markdown emphasis, CJK brackets, decorative punctuation runs.
                 The reader shows these literally and edge-tts pronounces them.
  2. Name drift — the same proper noun spelled two ways across chapters
                 ("Lư Tự Tự" vs "Lư Tư Tự"). Folded onto the glossary spelling.
  3. Report    — files that still contain hanzi. Those need re-translating, not
                 repairing, so they are only listed (or deleted with --delete-cjk
                 so the translate step regenerates them).

Pass 2 is deliberately conservative. Two distinct Chinese names can collapse to
one key when diacritics are stripped — 萧元思 → "Nguyên Tư" and 李渊修 → "Nguyên
Tu" are different characters, not a typo — so a variant is only rewritten when
the glossary names the correct spelling. Everything else is reported for review.

Idempotent: a cleaned file produces no further changes on re-run.

Usage (from backend/):
    python -m scripts.sanitize_translation work/xuanjian/vi --glossary work/xuanjian/glossary.json
    python -m scripts.sanitize_translation work/xuanjian/vi --glossary work/xuanjian/glossary.json --apply
    python -m scripts.sanitize_translation work/xuanjian/vi --glossary ... --apply --delete-cjk
"""
import argparse
import json
import logging
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("sanitize")

CJK_RE = re.compile(r"[一-鿿㐀-䶿]")
# The markers must not touch a letter or digit on their outer side. Without that
# guard "ghép hình 3*3, … bức thứ hai là 4*4" matched as one emphasis span and
# came out as "33 … 44" — the numbers silently fused. Real markdown emphasis
# never sits flush against a word character on the outside.
MD_EMPHASIS_RE = re.compile(
    r"(?<![^\W_])[*_]{1,3}(?=\S)(.+?)(?<=\S)[*_]{1,3}(?![^\W_])", re.DOTALL
)
CJK_BRACKET_RE = re.compile(r"[《》〈〉「」『』【】]")
# Runs of decorative punctuation the author used as chapter-note flourishes
# (~~~, ^^^, ——————). Deliberately excludes "." and ",": "..." is a legitimate
# ellipsis and appears constantly in this genre, so collapsing it would mangle
# dialogue into "Hình như. ta tạch rồi?".
DECOR_RUN_RE = re.compile(r"([~^!?;:—–])\1{2,}")
# Runaway dot runs still get normalised back to a plain three-dot ellipsis.
LONG_ELLIPSIS_RE = re.compile(r"\.{4,}")
# Zero-width and other invisible characters that survive copy-paste.
INVISIBLE_RE = re.compile(r"[​-‏‪-‮﻿\xad]")
WORD_CHAR = r"[^\W\d_]"


def strip_diacritics(s: str) -> str:
    """Fold 'Tự' and 'Tư' onto one key so drifted spellings cluster together."""
    s = s.replace("đ", "d").replace("Đ", "D")
    return "".join(
        c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c)
    ).lower()


SMART_DOUBLE = "“”„‟❝❞〝〞＂"
SMART_SINGLE = "‘’‚‛"


def normalize_quotes(text: str, style: str) -> str:
    """Force one quote style across a chapter.

    Each book has a house style set by the chapters already published, and the
    model mixes marks within a single chapter no matter what the prompt says —
    a run of 425 chapters will not stay consistent on instruction alone. Doing
    it deterministically here is the only way chapter 61 matches chapter 60.
    """
    if style == "straight":
        for ch in SMART_DOUBLE:
            text = text.replace(ch, '"')
        for ch in SMART_SINGLE:
            text = text.replace(ch, "'")
    elif style == "curly":
        # Only safe pairwise: turn "…" into “…” by alternating open/close.
        out, open_next = [], True
        for ch in text:
            if ch == '"':
                out.append("“" if open_next else "”")
                open_next = not open_next
            else:
                if ch == "\n":
                    open_next = True  # never let a pairing error span paragraphs
                out.append(ch)
        text = "".join(out)
    return text


# Filter-dodging dots. Wikidich-family sites break up words their keyword filter
# flags — "c·hết", "g·iết", "t·hi t·hể", even "đ·ã" — 23,750 dots across 74% of
# one book's chapters, sometimes trailing a word ("t·ham ô·"). TTS stumbles on
# every one. Inside a word the dot is deleted; before a capital it becomes a
# space instead, because translated books use it as a Western-name separator
# ("Đỗ·Duy") and deleting it would fuse the name.
#
# "Capital letter" is built from str.isupper(), NOT a range like À-Ỹ: Unicode
# interleaves Vietnamese upper and lower case in that block (Ạ ạ Ả ả …), so the
# range also matches "ị" — which turned "d·ịch" into "d ịch".
UPPER = "[" + re.escape("".join(
    c for c in map(chr, range(0x41, 0x2000)) if c.isalpha() and c.isupper()
)) + "]"
OBFUSCATION_DOT_RE = re.compile(rf"(?<=\w)[·‧・∙](?!{UPPER})|[·‧・∙](?=\w)(?!{UPPER})")
NAME_DOT_RE = re.compile(rf"(?<=\w)[·‧・∙](?={UPPER})")


def clean_markup(text: str, strip_filter_dots: bool = False) -> str:
    text = INVISIBLE_RE.sub("", text)
    # Opt-in: our own translations use "·" on purpose, as a separator inside
    # system-panel skill names ("[Cấm chú·Đá nuốt trời đất]"). Only scraped
    # wikidich text needs the filter-dodging dots taken out.
    if strip_filter_dots:
        text = NAME_DOT_RE.sub(" ", text)
        text = OBFUSCATION_DOT_RE.sub("", text)
    text = MD_EMPHASIS_RE.sub(r"\1", text)
    text = CJK_BRACKET_RE.sub("", text)
    text = DECOR_RUN_RE.sub(r"\1", text)
    text = LONG_ELLIPSIS_RE.sub("...", text)
    # Stripping 《 Tên Sách 》 leaves "vì  Tên Sách  cà". Collapse mid-line runs
    # only — [ \t], never \s, which would also eat the paragraph breaks.
    text = re.sub(r"(?<=\S)[ \t]{2,}", " ", text)
    # Vietnamese sets no space before , ! ? ; : — converters emit French-style
    # "thỏa mãn ?". Deliberately excludes "." and "…" (a spaced ellipsis can be
    # stylistic) and ” (some sources misuse it as an OPENING quote, where the
    # space is load-bearing). Only after a LETTER: after a digit the ratio
    # "8 : 1" would become "8: 1", and after a colon a LitRPG panel's unknown
    # value "[Phẩm cấp: ?]" would become "[Phẩm cấp:?]".
    text = re.sub(r"(?<=[^\W\d_])[ \t]+(?=[,!?;:])", "", text)
    # Trailing spaces before a newline, and blank-line runs left by the above.
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


# Rebuilding paragraphs for chapters a source site serves as one unbroken block
# (wikidich did this for 108 consecutive chapters of one book — zero <br> in the
# page HTML, so re-scraping cannot help). Scraped xianxia writes narration one
# sentence per paragraph, so break at every sentence end that starts a new
# sentence. Validated by flattening 102 real chapters and rebuilding them:
# 98.9% of the true breaks recovered, 90.2% of paragraphs rebuilt exactly, not
# one character changed.
#
# The last alternative handles 8 of those chapters where the site dropped the
# space along with the break ("nhiều.Hai người"). No digit there, so a decimal
# like "1.5" is never split.
_SENTENCE_BREAK_RE = re.compile(
    rf"(?<=[.!?…][”\"])\s+(?=[“\"\w])|(?<=[.!?…])\s+(?=[“\"0-9]|{UPPER})"
    rf"|(?<=[.!?…])(?=[“\"]|{UPPER})|(?<=[.!?…][”\"])(?=[“\"]|{UPPER})"
)
# A short sentence straight after a closing quote is almost always its speech
# tag ("“…?” Đại hán kia hỏi.") and stays on the quote's line. 40 chars was the
# best threshold in validation; longer lets real narration get absorbed.
_SPEECH_TAG_MAX = 40


def split_wall(paragraph: str) -> list[str]:
    """Split one run-together paragraph back into sentence paragraphs."""
    out: list[str] = []
    for s in _SENTENCE_BREAK_RE.split(paragraph):
        if not s.strip():
            continue
        if (
            out
            and out[-1].rstrip().endswith(("”", '"'))
            and not s.startswith(("“", '"'))
            and len(s) <= _SPEECH_TAG_MAX
        ):
            out[-1] = out[-1] + " " + s
        else:
            out.append(s)
    return out


def split_walls(text: str, min_len: int) -> tuple[str, int]:
    """Rebuild paragraphs longer than min_len; leaves everything else alone."""
    lines = text.split("\n")
    out, n = [], 0
    for line in lines:
        if len(line) > min_len:
            parts = split_wall(line.strip())
            if len(parts) > 1:
                out.append("\n\n".join(parts))
                n += 1
                continue
        out.append(line)
    return "\n".join(out), n


# A hanzi is sentence-initial when only an opening quote separates it from the
# start of the line or from sentence-ending punctuation.
_SENTENCE_START_RE = re.compile(r"(?:^|[.!?…]\s*)[\"“‘(]?\s*$")


def apply_hanzi_map(text: str, hanzi_map: dict[str, str]) -> tuple[str, int]:
    """Replace hanzi a converter left untransliterated with their Hán-Việt reading.

    Scraped books (wikidich and similar) are machine-converted, and the converter's
    dictionary misses rare characters, so they reach the reader verbatim:
    "kim 犐 ngọc thư". TTS either skips them or reads them in Chinese. They cannot
    be re-translated like our own output — the only fix is in place.

    Map values are the reading as it should appear mid-sentence: lowercase for a
    common noun ("khoa"), capitalised for a name ("Thương"). A lowercase reading
    is capitalised when it opens a sentence. An empty value deletes the run —
    for visual puns like 芔茻, which have no meaning when read aloud.
    """
    total = 0
    # Longest keys first so a multi-character run is not split by a shorter key.
    for han in sorted(hanzi_map, key=len, reverse=True):
        reading = hanzi_map[han]
        out, pos = [], 0
        for m in re.finditer(re.escape(han), text):
            before = text[pos : m.start()]
            line_start = text.rfind("\n", 0, m.start()) + 1
            word = reading
            if word and word[0].islower() and _SENTENCE_START_RE.search(text[line_start : m.start()]):
                word = word[0].upper() + word[1:]
            # Converters glue hanzi straight onto punctuation ("tung ảnh.牤 Ngưu");
            # a Latin word needs the space the hanzi never did.
            if word and before and not before[-1].isspace() and before[-1] not in "\"“‘(":
                word = " " + word
            after = text[m.end() : m.end() + 1]
            if word and after and (after.isalnum()):
                word = word + " "
            # A deletion must not strand its leading space: "thảo 芔茻, đây"
            # would become "thảo , đây". Tidy only here, at the deletion site —
            # never file-wide, which silently rewrote 74 untouched chapters.
            if not word and before.endswith((" ", "\t")) and (
                not after or after in " \t,.!?;:…”"
            ):
                before = before.rstrip(" \t")
            out.append(before + word)
            pos = m.end()
            total += 1
        out.append(text[pos:])
        text = "".join(out)
    return text, total


def build_name_map(files: list[Path], glossary: dict[str, str]) -> dict[str, str]:
    """Variant spelling -> glossary spelling, for glossary proper nouns only.

    Only multi-syllable capitalised glossary values are considered. Single common
    words ("tu vi", "linh căn") are skipped: their diacritic neighbourhood
    overlaps ordinary vocabulary and rewriting them would corrupt prose.
    """
    targets: dict[str, str] = {}
    for vi in glossary.values():
        if not vi[:1].isupper() or " " not in vi:
            continue
        targets[strip_diacritics(vi)] = vi

    # Some books capitalise ordinary cultivation vocabulary in the glossary
    # ("Pháp Khí", "Trận Pháp", "Yêu Thú"). Those are common nouns, not names:
    # folding every capitalised occurrence onto Title Case rewrites correct
    # sentence-initial prose ("Trận pháp này…" -> "Trận Pháp này…"). Decide from
    # the text itself — a term that appears mostly lowercase is a common noun.
    corpus = "\n".join(p.read_text(encoding="utf-8") for p in files)
    common: set[str] = set()
    for key, correct in targets.items():
        lower_hits = corpus.count(correct.lower())
        title_hits = corpus.count(correct)
        if lower_hits > title_hits:
            common.add(key)
    for key in common:
        logger.info(f"    (skipping {targets[key]!r} — reads as a common noun here)")
        del targets[key]

    # Scan sliding phrase windows for each glossary word count.  A single
    # greedy run across all lengths misses a name when it starts inside a
    # longer capitalised sequence (for example, "tổ chức Âm Hưng").  The
    # lookahead makes every word boundary a possible start without consuming
    # text, while horizontal whitespace prevents a match from crossing lines.
    seen: dict[str, Counter] = defaultdict(Counter)
    word_counts = sorted({len(v.split()) for v in targets.values()})
    for word_count in word_counts:
        phrase_re = re.compile(
            rf"(?<!{WORD_CHAR})(?=({WORD_CHAR}+(?:[ \t]+{WORD_CHAR}+)"
            rf"{{{word_count - 1}}})(?!{WORD_CHAR}))"
        )
        for m in phrase_re.finditer(corpus):
            phrase = m.group(1)
            if not phrase[:1].isupper():
                continue
            key = strip_diacritics(phrase)
            if key in targets:
                seen[key][phrase] += 1

    mapping: dict[str, str] = {}
    for key, correct in targets.items():
        for variant, n in seen.get(key, {}).items():
            if variant != correct:
                mapping[variant] = correct
                logger.info(f"    {variant!r} ({n}x) -> {correct!r}")
    return mapping


def apply_names(text: str, mapping: dict[str, str]) -> tuple[str, int]:
    total = 0
    for variant, correct in mapping.items():
        pattern = re.compile(
            rf"(?<!{WORD_CHAR}){re.escape(variant)}(?!{WORD_CHAR})"
        )
        text, n = pattern.subn(correct, text)
        total += n
    return text, total


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("directory", help="directory of translated .txt chapters")
    ap.add_argument("--glossary", help="glossary.json, authority for name spelling")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument(
        "--delete-cjk",
        action="store_true",
        help="delete files still containing hanzi so the translate step regenerates them. "
        "NEVER use this on a scraped book — there is no translate step to regenerate "
        "from, so it just deletes chapters. Use --hanzi-map instead",
    )
    ap.add_argument(
        "--strip-filter-dots",
        action="store_true",
        help="remove the dots wikidich-family sites insert to dodge keyword filters "
        "(\"c·hết\" -> \"chết\"). Scraped books only — our own translations use \"·\" "
        "deliberately as a separator in skill names",
    )
    ap.add_argument(
        "--split-walls",
        type=int,
        metavar="CHARS",
        help="rebuild paragraph breaks in any paragraph longer than CHARS (try 1500) — "
        "for chapters a site served as one unbroken block. Splits at sentence ends",
    )
    ap.add_argument(
        "--hanzi-map",
        help="JSON {\"犐\": \"khoa\", \"仺\": \"Thương\", \"芔茻\": \"\"} of Hán-Việt readings "
        "for hanzi a converter left untransliterated. Replaces them in place — the fix "
        "for scraped books, which cannot be re-translated",
    )
    ap.add_argument(
        "--normalize-quotes",
        choices=("straight", "curly"),
        help="force one dialogue quote style across every chapter. Set it to whatever "
        "the already-published chapters of this book use — the model mixes marks "
        "within a chapter regardless of the prompt",
    )
    ap.add_argument(
        "--min-age",
        type=float,
        default=0.0,
        help="skip files modified within this many seconds. Use when the translate "
        "step is still running: reading a chapter mid-write and saving it back "
        "would silently truncate it, and a non-empty file never gets regenerated",
    )
    args = ap.parse_args()

    d = Path(args.directory)
    if not d.is_dir():
        raise SystemExit(f"No such directory: {d}")
    files = sorted(d.glob("*.txt"))
    if not files:
        raise SystemExit(f"No .txt files in {d}")
    total_found = len(files)
    if args.min_age:
        cutoff = time.time() - args.min_age
        files = [f for f in files if f.stat().st_mtime < cutoff]
        skipped = total_found - len(files)
        if skipped:
            logger.info(f"Skipping {skipped} file(s) modified in the last {args.min_age:.0f}s")
    logger.info(f"{len(files)} of {total_found} chapter file(s) in {d}\n")

    glossary: dict[str, str] = {}
    if args.glossary:
        gpath = Path(args.glossary)
        if not gpath.is_file():
            raise SystemExit(f"No such glossary: {gpath}")
        glossary = json.loads(gpath.read_text(encoding="utf-8"))

    mapping: dict[str, str] = {}
    if glossary:
        logger.info("NAME DRIFT — variants folded onto the glossary spelling:")
        mapping = build_name_map(files, glossary)
        if not mapping:
            logger.info("    none found")
        logger.info("")

    hanzi_map: dict[str, str] = {}
    if args.hanzi_map:
        hpath = Path(args.hanzi_map)
        if not hpath.is_file():
            raise SystemExit(f"No such hanzi map: {hpath}")
        hanzi_map = json.loads(hpath.read_text(encoding="utf-8"))

    markup_changed = name_changed = name_total = hanzi_changed = hanzi_total = 0
    walls_changed = 0
    cjk_files: list[tuple[Path, int]] = []

    for path in files:
        original = path.read_text(encoding="utf-8")
        # Hanzi first: bracket-stripping and space-collapsing then tidy up after it.
        text, h = apply_hanzi_map(original, hanzi_map) if hanzi_map else (original, 0)
        if args.split_walls:
            text, w = split_walls(text, args.split_walls)
            if w:
                walls_changed += 1
        text = clean_markup(text, strip_filter_dots=args.strip_filter_dots)
        if args.normalize_quotes:
            text = normalize_quotes(text, args.normalize_quotes)
        m_changed = text != original
        text, n = apply_names(text, mapping)

        if m_changed:
            markup_changed += 1
        if h:
            hanzi_changed += 1
            hanzi_total += h
        if n:
            name_changed += 1
            name_total += n
        if args.apply and text != original:
            path.write_text(text, encoding="utf-8")

        left = len(CJK_RE.findall(text))
        if left:
            cjk_files.append((path, left))

    logger.info(f"markup cleaned:    {markup_changed} file(s)")
    if hanzi_map:
        logger.info(f"hanzi transliterated: {hanzi_total} in {hanzi_changed} file(s)")
    if args.split_walls:
        logger.info(f"walls split:       {walls_changed} file(s)")
    logger.info(f"names normalised:  {name_total} replacement(s) in {name_changed} file(s)")
    logger.info(f"still contain CJK: {len(cjk_files)} file(s), {sum(n for _, n in cjk_files)} char(s)")
    for path, n in cjk_files[:15]:
        logger.info(f"    {n:>4}  {path.name}")
    if len(cjk_files) > 15:
        logger.info(f"    ... and {len(cjk_files) - 15} more")

    if cjk_files and args.delete_cjk:
        if args.apply:
            for path, _ in cjk_files:
                path.unlink()
            logger.info(f"\nDeleted {len(cjk_files)} file(s) — re-run the translate step to regenerate")
        else:
            logger.info(f"\nWould delete {len(cjk_files)} file(s) for regeneration (--apply to do it)")

    if not args.apply:
        logger.info("\nDRY RUN — nothing written. Re-run with --apply.")


if __name__ == "__main__":
    main()
