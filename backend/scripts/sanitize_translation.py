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
MD_EMPHASIS_RE = re.compile(r"[*_]{1,3}(?=\S)(.+?)(?<=\S)[*_]{1,3}", re.DOTALL)
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


def clean_markup(text: str) -> str:
    text = INVISIBLE_RE.sub("", text)
    text = MD_EMPHASIS_RE.sub(r"\1", text)
    text = CJK_BRACKET_RE.sub("", text)
    text = DECOR_RUN_RE.sub(r"\1", text)
    text = LONG_ELLIPSIS_RE.sub("...", text)
    # Trailing spaces before a newline, and blank-line runs left by the above.
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


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

    # Collect capitalised runs of the same length as each target.
    seen: dict[str, Counter] = defaultdict(Counter)
    max_words = max((len(v.split()) for v in targets.values()), default=0)
    if not max_words:
        return {}
    run_re = re.compile(rf"(?:{WORD_CHAR}+)(?:\s+{WORD_CHAR}+){{0,{max_words - 1}}}")
    for path in files:
        text = path.read_text(encoding="utf-8")
        for m in run_re.finditer(text):
            phrase = m.group(0)
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
        help="delete files still containing hanzi so the translate step regenerates them",
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

    markup_changed = name_changed = name_total = 0
    cjk_files: list[tuple[Path, int]] = []

    for path in files:
        original = path.read_text(encoding="utf-8")
        text = clean_markup(original)
        if args.normalize_quotes:
            text = normalize_quotes(text, args.normalize_quotes)
        m_changed = text != original
        text, n = apply_names(text, mapping)

        if m_changed:
            markup_changed += 1
        if n:
            name_changed += 1
            name_total += n
        if args.apply and text != original:
            path.write_text(text, encoding="utf-8")

        left = len(CJK_RE.findall(text))
        if left:
            cjk_files.append((path, left))

    logger.info(f"markup cleaned:    {markup_changed} file(s)")
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
