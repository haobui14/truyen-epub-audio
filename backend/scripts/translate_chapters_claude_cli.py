"""Translate split Chinese chapter files to Vietnamese via claude-agent-sdk.

Uses your Claude subscription, not API billing: claude-agent-sdk drives the
bundled Claude Code CLI as a subprocess, and the CLI resolves auth from the
environment — with no ANTHROPIC_API_KEY set it falls back to the OAuth
credentials in ~/.claude/ written by `claude login`. This script unsets
ANTHROPIC_API_KEY for the run by default so a stray key can't silently switch
you to API billing (pass --use-api-key to keep it).

Same input/output/glossary/style contract as the DeepSeek and Messages-API
translators — swap freely between the three.

Resumable: a chapter whose output file exists and is non-empty is skipped, so you
can stop, hit a usage limit, and re-run later without losing work. Rate-limit
rejections stop the run cleanly rather than burning every retry.

Every chapter is checked on write for the three failure modes that actually
occurred in this book's existing online copy: truncation (VI/CN char ratio),
dropped or merged paragraphs (paragraph-count delta), and untranslated Chinese
(which TTS reads aloud wrong).

Setup: pip install claude-agent-sdk   (Claude Code must already be logged in)

Usage (from backend/):
    python -m scripts.translate_chapters_claude_cli ../work/cn -o ../work/vi
    python -m scripts.translate_chapters_claude_cli ../work/cn -o ../work/vi --limit 2 --apply
    python -m scripts.translate_chapters_claude_cli ../work/cn -o ../work/vi --apply
"""
import argparse
import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    RateLimitEvent,
    ResultMessage,
    TextBlock,
    query,
)

from scripts.translate_chapters_deepseek import (
    CJK_RE,
    GENRES,
    QUOTE_RULES,
    TITLE_CASE_RULES,
    build_style_block,
    build_system_prompt,
    chunk_text,
)
from scripts.translate_chapters_claude import USER_TEMPLATE

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("translate_claude_sdk")

CHUNK_CHARS = 12000


class RateLimited(RuntimeError):
    """The subscription's usage limit rejected the request — stop the whole run."""


def build_system(args: argparse.Namespace) -> str:
    glossary: dict[str, str] = {}
    if args.glossary and Path(args.glossary).exists():
        glossary = json.loads(Path(args.glossary).read_text(encoding="utf-8"))
        logger.info(f"Loaded {len(glossary)} glossary term(s)")

    style_cn = args.style_cn or []
    style_vi = args.style_vi or []
    if len(style_cn) != len(style_vi):
        raise SystemExit("--style-cn and --style-vi must be given the same number of times")
    pairs = [(Path(c), Path(v)) for c, v in zip(style_cn, style_vi)]
    for c, v in pairs:
        if not c.is_file() or not v.is_file():
            raise SystemExit(f"Style example missing: {c if not c.is_file() else v}")
    if pairs:
        logger.info(f"Using {len(pairs)} style example pair(s), {args.style_paras} paragraphs each")

    return build_system_prompt(
        glossary,
        args.max_glossary_terms,
        build_style_block(pairs, args.style_paras),
        args.quote_style,
        args.title_case,
        args.genre,
    )


def build_options(system: str, args: argparse.Namespace) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        system_prompt=system,
        # No tools: this is pure text generation. A tool call here would mean the
        # model went looking at the filesystem instead of translating.
        tools=[],
        model=args.model,
        effort=args.effort,
        # One turn: it answers once and stops, never continuing agentically.
        max_turns=1,
        # None = don't load user/project settings, so no CLAUDE.md or project
        # memory can leak into a translation prompt.
        setting_sources=None,
        cli_path=args.claude_bin,
    )


async def translate_once(user: str, options: ClaudeAgentOptions) -> tuple[str, float]:
    """One query. Returns (text, reported_cost). Raises RateLimited on rejection."""
    parts: list[str] = []
    result: ResultMessage | None = None

    async for msg in query(prompt=user, options=options):
        if isinstance(msg, AssistantMessage):
            # Text can arrive across several AssistantMessages — collect them all.
            # ThinkingBlocks are skipped by the isinstance filter.
            parts += [b.text for b in msg.content if isinstance(b, TextBlock)]
        elif isinstance(msg, RateLimitEvent):
            info = msg.rate_limit_info
            note = (
                f"rate limit {info.rate_limit_type}: {info.status} "
                f"(utilization {info.utilization}, resets {info.resets_at})"
            )
            if info.status == "rejected":
                raise RateLimited(note)
            if info.status == "allowed_warning":
                logger.warning(f"  {note}")
        elif isinstance(msg, ResultMessage):
            result = msg

    if result is not None and result.is_error:
        raise RuntimeError(f"CLI reported an error: {str(result.result)[:200]}")
    return "\n\n".join(parts).strip(), float(getattr(result, "total_cost_usd", 0.0) or 0.0)


def check_quality(name: str, source: str, body: str, args: argparse.Namespace) -> None:
    cn_paras = len([l for l in source.splitlines() if l.strip()])
    vi_paras = len([l for l in body.splitlines() if l.strip()])
    if abs(cn_paras - vi_paras) > args.para_tolerance:
        logger.warning(
            f"  {name}: {vi_paras} VI paragraphs vs {cn_paras} CN — possible truncation "
            "or merged paragraphs, check this one"
        )
    leftover = len(CJK_RE.findall(body))
    if leftover:
        logger.warning(f"  {name}: {leftover} Chinese char(s) left — TTS will read these wrong")
    ratio = len(body) / max(len(source), 1)
    if ratio < args.min_ratio:
        logger.warning(f"  {name}: VI/CN ratio {ratio:.2f} below {args.min_ratio} — likely truncated")


async def run_all(todo: list[Path], out_dir: Path, args: argparse.Namespace) -> None:
    options = build_options(build_system(args), args)
    sem = asyncio.Semaphore(args.concurrency)
    stop = asyncio.Event()
    state = {"done": 0, "cost": 0.0}
    failed: list[str] = []

    async def one(src: Path) -> None:
        if stop.is_set():
            return
        text = src.read_text(encoding="utf-8").strip()
        if not text:
            return
        title = text.splitlines()[0].strip()

        parts: list[str] = []
        cost = 0.0
        for chunk in chunk_text(text, args.chunk_chars):
            user = USER_TEMPLATE.format(title=title, chunk=chunk)
            delay = 5.0
            for attempt in range(1, args.retries + 1):
                if stop.is_set():
                    return
                try:
                    async with sem:
                        piece, c = await translate_once(user, options)
                    if not piece:
                        raise RuntimeError("empty result")
                    # A chapter over --chunk-chars is sent as several stateless
                    # calls, and chunks 2+ re-emit the chapter heading, leaving
                    # one file carrying two differently-worded headings. Drop
                    # any heading after the first. (Same fix as the DeepSeek
                    # translator; this path was missing it.)
                    if parts:
                        lines = piece.splitlines()
                        if lines and re.match(r"^\s*Chương\s*\d+\s*:", lines[0]):
                            piece = "\n".join(lines[1:]).lstrip()
                    parts.append(piece)
                    cost += c
                    break
                except RateLimited as e:
                    # Retrying is pointless until the window resets — stop everything.
                    if not stop.is_set():
                        logger.error(f"USAGE LIMIT REACHED — {e}")
                        logger.error(
                            "Stopping. Already-translated chapters are saved; "
                            "re-run the same command after the reset to resume."
                        )
                        stop.set()
                    return
                except Exception as e:  # noqa: BLE001 — one bad chapter shouldn't kill the run
                    if attempt == args.retries:
                        failed.append(src.name)
                        logger.error(f"FAILED {src.name}: {e}")
                        return
                    logger.warning(
                        f"  {src.name} attempt {attempt}/{args.retries} failed ({e}); "
                        f"retrying in {delay:.0f}s"
                    )
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 120)

        body = "\n\n".join(parts).strip() + "\n"
        check_quality(src.name, text, body, args)
        (out_dir / src.name).write_text(body, encoding="utf-8")

        state["done"] += 1
        state["cost"] += cost
        vi_paras = len([l for l in body.splitlines() if l.strip()])
        cn_paras = len([l for l in text.splitlines() if l.strip()])
        logger.info(
            f"[{state['done']}/{len(todo)}] {src.name} — {len(body):,} chars, "
            f"ratio {len(body) / max(len(text), 1):.2f}, {vi_paras}/{cn_paras} paras"
        )

    await asyncio.gather(*(one(f) for f in todo))

    logger.info(f"Done: {state['done']} translated, {len(failed)} failed")
    logger.info(
        f"Reported usage value: ${state['cost']:.2f} "
        "(what this would have cost on the API; not a separate charge)"
    )
    if failed:
        logger.warning(f"Re-run the same command to retry the {len(failed)} failure(s): {failed[:10]}")


def run(args: argparse.Namespace) -> None:
    in_dir, out_dir = Path(args.input), Path(args.out)
    if not in_dir.is_dir():
        raise SystemExit(f"No such directory: {in_dir}")

    files = sorted(in_dir.glob("*.txt"))
    if args.limit:
        files = files[: args.limit]
    if not files:
        raise SystemExit(f"No .txt files in {in_dir}")

    todo = [
        f
        for f in files
        if args.force or not ((out_dir / f.name).exists() and (out_dir / f.name).stat().st_size > 0)
    ]
    skipped = len(files) - len(todo)

    # The CLI picks API billing whenever this is set. Drop it so a key left in the
    # environment can't silently move the run off the subscription.
    if os.environ.get("ANTHROPIC_API_KEY"):
        if args.use_api_key:
            logger.warning("ANTHROPIC_API_KEY is set — this run will bill API usage, not subscription")
        else:
            os.environ.pop("ANTHROPIC_API_KEY", None)
            logger.info("Unset ANTHROPIC_API_KEY for this run (--use-api-key to keep it)")

    logger.info(f"{len(files)} chapter file(s); {skipped} already translated, {len(todo)} to do")
    logger.info(
        f"~{args.seconds_each}s each at --concurrency {args.concurrency} "
        f"≈ {len(todo) * args.seconds_each / max(args.concurrency, 1) / 3600:.1f}h wall clock"
    )
    logger.info("Runs on your Claude subscription and counts against its usage limits.")

    if not args.apply:
        logger.info("DRY RUN — nothing sent, nothing written. Re-run with --apply.")
        logger.info("Tip: --limit 2 --apply first to eyeball the tone before the full run.")
        return
    if not todo:
        logger.info("Nothing to do.")
        return

    out_dir.mkdir(parents=True, exist_ok=True)
    asyncio.run(run_all(todo, out_dir, args))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", help="directory of Chinese chapter .txt files")
    ap.add_argument("-o", "--out", required=True, help="directory for Vietnamese output")
    # Sonnet is the working default here: this is a long unattended book run on a
    # subscription, and translation is a mechanical task that does not need Opus.
    ap.add_argument("--model", default="sonnet", help="model alias (default: sonnet)")
    # House style and genre must match whatever the DeepSeek half of the book used,
    # or chapter N+1 reads unlike chapter N. Same flags, same meanings.
    ap.add_argument("--genre", choices=sorted(GENRES), default="xianxia",
                    help="terminology/honorifics set; use 'fantasy' for magic-and-knights books")
    ap.add_argument("--quote-style", choices=sorted(QUOTE_RULES), default="curly",
                    help="dialogue quote marks (default: curly)")
    ap.add_argument("--title-case", choices=sorted(TITLE_CASE_RULES), default="title",
                    help="chapter-heading capitalisation (default: title)")
    ap.add_argument(
        "--effort",
        choices=["low", "medium", "high", "xhigh", "max"],
        default="low",
        help="thinking depth (default: low)",
    )
    ap.add_argument("--concurrency", type=int, default=3, help="parallel chapters (default: 3)")
    ap.add_argument("--chunk-chars", type=int, default=CHUNK_CHARS, help=f"default: {CHUNK_CHARS}")
    ap.add_argument("--retries", type=int, default=4, help="attempts per chunk (default: 4)")
    ap.add_argument("--limit", type=int, help="only process the first N chapters (test runs)")
    ap.add_argument("--force", action="store_true", help="re-translate chapters already done")
    ap.add_argument("--glossary", help="path to glossary.json")
    ap.add_argument("--max-glossary-terms", type=int, default=300, help="default: 300")
    ap.add_argument("--style-cn", action="append", help="Chinese chapter used as a style example")
    ap.add_argument("--style-vi", action="append", help="approved Vietnamese match for --style-cn")
    ap.add_argument("--style-paras", type=int, default=8, help="paragraphs per example (default: 8)")
    ap.add_argument("--claude-bin", help="explicit path to the claude executable")
    ap.add_argument(
        "--use-api-key",
        action="store_true",
        help="keep ANTHROPIC_API_KEY (bills API usage instead of the subscription)",
    )
    ap.add_argument(
        "--para-tolerance", type=int, default=2, help="allowed VI/CN paragraph delta (default: 2)"
    )
    ap.add_argument(
        "--min-ratio", type=float, default=2.4, help="warn below this VI/CN char ratio (default: 2.4)"
    )
    ap.add_argument(
        "--seconds-each", type=int, default=90, help="per-chapter estimate for the ETA (default: 90)"
    )
    ap.add_argument("--apply", action="store_true", help="actually run (default: dry run)")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
