"""Convert a hand-written Chinese→Vietnamese glossary table into glossary.json.

Reads any markdown file containing pipe tables whose first column is the Chinese
term and whose third column is the Vietnamese rendering, and writes the flat
{"中文": "Tiếng Việt"} map the translators consume via --glossary.

Keep the markdown as the source of truth and re-run this after editing it.

Usage (from backend/):
    python -m scripts.glossary_from_markdown ../work/glossary_source.md -o ../work/glossary.json
"""
import argparse
import json
import logging
import re
import sys
from collections import defaultdict
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("glossary_from_markdown")

CJK_RE = re.compile(r"[一-鿿㐀-䶿]")
SEPARATOR_RE = re.compile(r"^[\s|:-]+$")


def parse(md: str) -> tuple[dict[str, str], list[str]]:
    terms: dict[str, str] = {}
    conflicts: list[str] = []

    for raw in md.splitlines():
        line = raw.strip()
        if not line.startswith("|") or SEPARATOR_RE.match(line):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 3:
            continue
        cn, vi = cells[0], cells[2]
        # Header rows and prose rows have no Chinese in column 1.
        if not cn or not vi or not CJK_RE.search(cn):
            continue
        # "Linh Mễ / Gạo Linh" -> take the first form: the whole point of a
        # glossary is that one term has exactly one rendering.
        vi = vi.split("/")[0].strip()
        if not vi:
            continue
        if cn in terms and terms[cn] != vi:
            conflicts.append(f"{cn}: kept '{terms[cn]}', also saw '{vi}'")
            continue
        terms[cn] = vi
    return terms, conflicts


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="markdown file containing the glossary tables")
    ap.add_argument("-o", "--out", required=True, help="glossary.json path")
    args = ap.parse_args()

    src = Path(args.source)
    if not src.is_file():
        raise SystemExit(f"No such file: {src}")

    terms, conflicts = parse(src.read_text(encoding="utf-8"))
    if not terms:
        raise SystemExit("No glossary rows found — check the table format")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(terms, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8"
    )
    logger.info(f"Wrote {len(terms)} term(s) to {out}")

    if conflicts:
        logger.warning(f"{len(conflicts)} conflicting row(s) — first value kept:")
        for c in conflicts:
            logger.warning(f"   {c}")

    # Two different Chinese terms sharing one Vietnamese rendering is normal in
    # Hán-Việt (练气 the realm vs 炼器 artifact-refining are both "Luyện Khí"),
    # but worth surfacing so it's a deliberate choice rather than a typo.
    reverse: dict[str, list[str]] = defaultdict(list)
    for cn, vi in terms.items():
        reverse[vi].append(cn)
    shared = {vi: cns for vi, cns in reverse.items() if len(cns) > 1}
    if shared:
        logger.info(f"{len(shared)} Vietnamese term(s) used for more than one Chinese term:")
        for vi, cns in shared.items():
            logger.info(f"   {vi}: {' / '.join(cns)}")


if __name__ == "__main__":
    main()
