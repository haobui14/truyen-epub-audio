"""Audit a directory of translated chapters against the Chinese source.

Checks the three failure modes that actually damaged this book's earlier
translation, plus the one that only appears at scale:

  1. Truncation      — VI/CN character ratio far below the corpus median
  2. Lost structure  — VI paragraph count differing from the Chinese
  3. Untranslated    — leftover Han characters (TTS reads these wrong)
  4. Name drift      — the same proper noun spelled two ways across chapters,
                       e.g. "Triêu Vân" in one chapter and "Triều Vân" in another

Drift is the one you cannot eyeball: a name can be perfectly consistent for 200
chapters and slip afterwards. Candidate names are grouped by their
diacritic-stripped form, so spellings that differ only in tone marks land in the
same cluster and get reported together — with the glossary's spelling marked as
the correct one where the glossary covers it.

Usage (from backend/):
    python -m scripts.audit_translation ../work/cn ../work/vi --glossary ../work/glossary.json
    python -m scripts.audit_translation ../work/cn ../work/vi -o ../work/audit.json
"""
import argparse
import json
import logging
import re
import statistics
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("audit")

CJK_RE = re.compile(r"[一-鿿㐀-䶿]")
WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
# A capitalised word right after these is capitalised by grammar, not because
# it is a name — excluding them removes most false positives.
SENTENCE_END = set('.!?:;"“”\'’()[]—–-…')

# Common Vietnamese words that start sentences; capitalised but never names.
STOPWORDS = {
    "ta", "ngươi", "hắn", "nàng", "nó", "họ", "chúng", "một", "hai", "ba", "này", "đó",
    "nhưng", "và", "là", "có", "không", "được", "cũng", "đã", "sẽ", "khi", "nếu", "vì",
    "thì", "mà", "cho", "với", "trong", "ngoài", "trên", "dưới", "sau", "trước", "lúc",
    "chỉ", "còn", "đều", "rất", "quá", "lại", "nữa", "vẫn", "tuy", "dù", "bởi", "do",
    "ông", "bà", "anh", "chị", "em", "con", "người", "cái", "những", "các", "mỗi",
    "the", "a", "an",
}


def strip_diacritics(s: str) -> str:
    """Fold 'Triều' and 'Triêu' onto the same key so drift clusters together."""
    s = s.replace("đ", "d").replace("Đ", "D")
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c)).lower()


def extract_names(text: str, max_len: int = 4) -> Counter:
    """Runs of consecutive capitalised words, skipping sentence-initial ones."""
    names: Counter = Counter()
    for line in text.splitlines():
        toks = [(m.group(0), m.start()) for m in WORD_RE.finditer(line)]
        run: list[str] = []
        for i, (word, pos) in enumerate(toks):
            prev = line[:pos].rstrip()
            sentence_initial = not prev or prev[-1] in SENTENCE_END
            is_cap = word[:1].isupper()
            # Only break a run on a sentence-initial cap when the run is empty:
            # mid-name words are never sentence-initial.
            if is_cap and word.lower() not in STOPWORDS and not (sentence_initial and not run):
                run.append(word)
                continue
            if is_cap and sentence_initial and not run and word.lower() not in STOPWORDS:
                continue
            if len(run) >= 2:
                for n in range(2, min(len(run), max_len) + 1):
                    for s in range(len(run) - n + 1):
                        names[" ".join(run[s : s + n])] += 1
            run = []
        if len(run) >= 2:
            for n in range(2, min(len(run), max_len) + 1):
                for s in range(len(run) - n + 1):
                    names[" ".join(run[s : s + n])] += 1
    return names


def audit(cn_dir: Path, vi_dir: Path, glossary: dict[str, str], args) -> dict:
    vi_files = sorted(vi_dir.glob("*.txt"))
    if not vi_files:
        raise SystemExit(f"No .txt files in {vi_dir}")

    rows = []
    corpus_names: Counter = Counter()
    name_chapters: dict[str, set] = defaultdict(set)

    for vf in vi_files:
        cf = cn_dir / vf.name
        vi_text = vf.read_text(encoding="utf-8")
        cn_text = cf.read_text(encoding="utf-8") if cf.is_file() else ""
        vi_paras = len([l for l in vi_text.splitlines() if l.strip()])
        cn_paras = len([l for l in cn_text.splitlines() if l.strip()])
        rows.append(
            {
                "file": vf.name,
                "vi_chars": len(vi_text),
                "cn_chars": len(cn_text),
                "ratio": round(len(vi_text) / len(cn_text), 3) if cn_text else None,
                "vi_paras": vi_paras,
                "cn_paras": cn_paras,
                "para_delta": vi_paras - cn_paras if cn_text else None,
                "cjk": len(CJK_RE.findall(vi_text)),
                "missing_source": not cf.is_file(),
            }
        )
        for name, n in extract_names(vi_text).items():
            corpus_names[name] += n
            name_chapters[name].add(vf.name)

    # ---- structural findings -------------------------------------------------
    ratios = [r["ratio"] for r in rows if r["ratio"]]
    median = statistics.median(ratios) if ratios else 0.0
    floor = median * args.ratio_floor_frac

    truncated = [r for r in rows if r["ratio"] and r["ratio"] < floor]
    structural = [r for r in rows if r["para_delta"] is not None and abs(r["para_delta"]) > args.para_tolerance]
    untranslated = [r for r in rows if r["cjk"] > 0]
    orphans = [r for r in rows if r["missing_source"]]

    # ---- name drift ---------------------------------------------------------
    gloss_terms = {v for v in glossary.values()}
    gloss_by_key = {strip_diacritics(v): v for v in gloss_terms}

    clusters: dict[str, Counter] = defaultdict(Counter)
    for name, n in corpus_names.items():
        if n >= args.min_occurrences:
            clusters[strip_diacritics(name)][name] = n

    drift = []
    for key, variants in clusters.items():
        if len(variants) < 2:
            continue
        canonical = gloss_by_key.get(key)
        ordered = variants.most_common()
        # Ignore pure case differences at the start of a sentence.
        if len({v.lower() for v in variants}) < 2:
            continue
        drift.append(
            {
                "key": key,
                "glossary": canonical,
                "variants": [
                    {"text": t, "count": c, "chapters": len(name_chapters[t])} for t, c in ordered
                ],
            }
        )
    drift.sort(key=lambda d: (d["glossary"] is None, -sum(v["count"] for v in d["variants"])))

    # ---- glossary coverage --------------------------------------------------
    blob = "\n".join(f.read_text(encoding="utf-8") for f in vi_files)
    coverage = {cn: blob.count(vi) for cn, vi in glossary.items()}
    used = {k: v for k, v in coverage.items() if v}

    return {
        "chapters": len(rows),
        "median_ratio": round(median, 3),
        "rows": rows,
        "truncated": truncated,
        "structural": structural,
        "untranslated": untranslated,
        "orphans": orphans,
        "drift": drift,
        "glossary_used": len(used),
        "glossary_total": len(glossary),
        "glossary_occurrences": sum(used.values()),
    }


def report(a: dict, args) -> None:
    logger.info(f"\n{'=' * 66}\nAUDIT — {a['chapters']} chapter(s), median VI/CN ratio {a['median_ratio']}\n{'=' * 66}")

    def section(title: str, items: list, fmt) -> None:
        if not items:
            logger.info(f"  OK   {title}: none")
            return
        logger.info(f"  WARN {title}: {len(items)}")
        for r in items[: args.show]:
            logger.info(f"         {fmt(r)}")
        if len(items) > args.show:
            logger.info(f"         ... and {len(items) - args.show} more")

    section("Truncated (ratio far below median)", a["truncated"],
            lambda r: f"{r['file']}  ratio {r['ratio']}")
    section("Paragraph-count mismatch", a["structural"],
            lambda r: f"{r['file']}  VI {r['vi_paras']} vs CN {r['cn_paras']} ({r['para_delta']:+d})")
    section("Leftover Chinese", a["untranslated"],
            lambda r: f"{r['file']}  {r['cjk']} char(s)")
    section("No matching source file", a["orphans"], lambda r: r["file"])

    logger.info(
        f"\n  Glossary: {a['glossary_used']}/{a['glossary_total']} terms seen, "
        f"{a['glossary_occurrences']} occurrences"
    )

    logger.info(f"\n{'-' * 66}\nNAME DRIFT — same name, more than one spelling\n{'-' * 66}")
    if not a["drift"]:
        logger.info("  OK   none detected")
    else:
        conflicting = [d for d in a["drift"] if d["glossary"]]
        logger.info(
            f"  {len(a['drift'])} cluster(s); {len(conflicting)} involve a glossary term"
        )
        for d in a["drift"][: args.show]:
            tag = f"  [glossary: {d['glossary']}]" if d["glossary"] else ""
            logger.info(f"\n    {d['key']}{tag}")
            for v in d["variants"]:
                mark = "  <-- matches glossary" if v["text"] == d["glossary"] else ""
                logger.info(f"       {v['text']:32} {v['count']:>5}x  in {v['chapters']} chapter(s){mark}")
        if len(a["drift"]) > args.show:
            logger.info(f"\n    ... and {len(a['drift']) - args.show} more cluster(s)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cn_dir", help="directory of Chinese source chapters")
    ap.add_argument("vi_dir", help="directory of translated chapters")
    ap.add_argument("--glossary", help="glossary.json, to mark canonical spellings")
    ap.add_argument("-o", "--out", help="write the full report as JSON")
    ap.add_argument("--para-tolerance", type=int, default=2, help="allowed paragraph delta (default: 2)")
    ap.add_argument(
        "--ratio-floor-frac",
        type=float,
        default=0.7,
        help="flag chapters below this fraction of the median ratio (default: 0.7)",
    )
    ap.add_argument(
        "--min-occurrences",
        type=int,
        default=3,
        help="ignore candidate names rarer than this (default: 3)",
    )
    ap.add_argument("--show", type=int, default=12, help="max items per section (default: 12)")
    args = ap.parse_args()

    glossary = {}
    if args.glossary and Path(args.glossary).exists():
        glossary = json.loads(Path(args.glossary).read_text(encoding="utf-8"))

    a = audit(Path(args.cn_dir), Path(args.vi_dir), glossary, args)
    report(a, args)

    if args.out:
        Path(args.out).write_text(json.dumps(a, ensure_ascii=False, indent=1), encoding="utf-8")
        logger.info(f"\nFull report: {args.out}")


if __name__ == "__main__":
    main()
