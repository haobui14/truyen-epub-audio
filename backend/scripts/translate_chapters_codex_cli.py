"""Translate split Chinese chapter files to Vietnamese via the Codex CLI.

Uses the authentication already configured by ``codex login``. Each chapter (or
oversized chapter chunk) is sent to a separate, ephemeral ``codex exec`` process.
The process is read-only, cannot request approval, and ignores user/project
rules so unrelated coding instructions do not leak into the translation.

Same input/output/glossary/style contract as the DeepSeek and Claude CLI
translators. Output is resumable: an existing non-empty chapter is skipped
unless ``--force`` is supplied.

Setup: install Codex CLI and run ``codex login`` once.

Usage (from backend/):
    python -m scripts.translate_chapters_codex_cli ../work/cn -o ../work/vi
    python -m scripts.translate_chapters_codex_cli ../work/cn -o ../work/vi --limit 2 --apply
    python -m scripts.translate_chapters_codex_cli ../work/cn -o ../work/vi --apply
    python -m scripts.translate_chapters_codex_cli ../work/cn -o ../work/vi --model gpt-5.6 --apply
"""

import argparse
import asyncio
import json
import logging
import re
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.translate_chapters_deepseek import (
    CJK_RE,
    ECHO_CJK_THRESHOLD,
    ECHO_MIN_PARA_CHARS,
    ECHO_PARA_CJK_THRESHOLD,
    EXPANSION_MIN_SOURCE_CHARS,
    GENRES,
    HYBRID_WORD_RE,
    MIN_EXPANSION,
    MIN_PARA_FRACTION,
    QUOTE_RULES,
    TITLE_CASE_RULES,
    build_style_block,
    build_system_prompt,
    chunk_text,
    sanitize,
)

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("translate_codex_cli")

CHUNK_CHARS = 12000

USER_TEMPLATE = """You are performing a text-only translation task.
Do not inspect files, invoke tools, run commands, or edit the workspace.

TRANSLATION INSTRUCTIONS
========================
{system}

SOURCE CHAPTER
==============
[Chapter: {title}]

Translate the complete Chinese text below to Vietnamese under the instructions
above. Emit the translated heading exactly once as the first line. Return only
the Vietnamese translation, with no Markdown fence, preamble, or commentary.

{chunk}
"""

RATE_LIMIT_RE = re.compile(
    r"(?:rate.?limit|usage.?limit|too many requests|quota|status.?429|http.?429)",
    re.IGNORECASE,
)


class RateLimited(RuntimeError):
    """The Codex account's usage window rejected the request."""


def build_system(args: argparse.Namespace) -> str:
    glossary: dict[str, str] = {}
    if args.glossary:
        glossary_path = Path(args.glossary)
        if not glossary_path.is_file():
            raise SystemExit(f"Glossary file does not exist: {glossary_path}")
        glossary = json.loads(glossary_path.read_text(encoding="utf-8"))
        logger.info(f"Loaded {len(glossary)} glossary term(s)")

    style_cn = args.style_cn or []
    style_vi = args.style_vi or []
    if len(style_cn) != len(style_vi):
        raise SystemExit("--style-cn and --style-vi must be given the same number of times")
    pairs = [(Path(c), Path(v)) for c, v in zip(style_cn, style_vi)]
    for cn_path, vi_path in pairs:
        if not cn_path.is_file() or not vi_path.is_file():
            missing = cn_path if not cn_path.is_file() else vi_path
            raise SystemExit(f"Style example missing: {missing}")
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


def resolve_codex_bin(value: str) -> str:
    """Resolve early so a missing CLI fails before any chapter work starts."""
    resolved = shutil.which(value)
    if resolved:
        return resolved
    candidate = Path(value)
    if candidate.is_file():
        return str(candidate.resolve())
    raise SystemExit(
        f"Codex CLI not found: {value!r}. Install it, add it to PATH, or pass --codex-bin."
    )


def codex_command(
    codex_bin: str,
    output_path: Path,
    args: argparse.Namespace,
) -> list[str]:
    command = [
        codex_bin,
        "--ask-for-approval",
        "never",
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ignore-rules",
        "--color",
        "never",
    ]
    if not args.keep_user_config:
        command.append("--ignore-user-config")
    if args.model:
        command.extend(("--model", args.model))
    command.extend(
        (
            "--config",
            f'model_reasoning_effort="{args.effort}"',
            "--output-last-message",
            str(output_path),
            "-",
        )
    )
    return command


async def translate_once(
    prompt: str,
    codex_bin: str,
    temp_dir: Path,
    request_id: int,
    args: argparse.Namespace,
) -> str:
    """Run one isolated Codex turn and return its final agent message."""
    output_path = temp_dir / f"result-{request_id:06d}.txt"
    process = await asyncio.create_subprocess_exec(
        *codex_command(codex_bin, output_path, args),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        # An empty working directory prevents AGENTS.md and repository context
        # from affecting a pure text-generation task.
        cwd=str(temp_dir),
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(prompt.encode("utf-8")),
            timeout=args.timeout_seconds,
        )
    except TimeoutError:
        process.kill()
        await process.communicate()
        raise RuntimeError(f"Codex timed out after {args.timeout_seconds}s") from None

    stdout_text = stdout.decode("utf-8", errors="replace").strip()
    stderr_text = stderr.decode("utf-8", errors="replace").strip()
    if process.returncode != 0:
        detail = stderr_text or stdout_text or f"exit code {process.returncode}"
        detail = detail[-1000:]
        if RATE_LIMIT_RE.search(detail):
            raise RateLimited(detail)
        raise RuntimeError(f"Codex CLI failed: {detail}")

    # --output-last-message is the stable interface for downstream scripts. The
    # stdout fallback keeps this usable with older Codex builds that still print
    # a final response but fail to create the requested file.
    if output_path.is_file():
        result = output_path.read_text(encoding="utf-8").strip()
    else:
        result = stdout_text
    if not result:
        raise RuntimeError("Codex returned an empty final message")
    return result


def validate_piece(source: str, output: str, args: argparse.Namespace) -> None:
    """Reject failures that would otherwise silently corrupt an output chapter."""
    cjk_fraction = len(CJK_RE.findall(output)) / max(len(output), 1)
    if cjk_fraction > ECHO_CJK_THRESHOLD:
        raise RuntimeError(
            f"response is {cjk_fraction:.0%} Chinese — Codex echoed the source"
        )

    for paragraph in re.split(r"\n\s*\n", output):
        paragraph = paragraph.strip()
        if len(paragraph) >= ECHO_MIN_PARA_CHARS:
            fraction = len(CJK_RE.findall(paragraph)) / len(paragraph)
            if fraction > ECHO_PARA_CJK_THRESHOLD:
                raise RuntimeError(
                    f"a {len(paragraph)}-char paragraph is {fraction:.0%} Chinese — partial echo"
                )

    hybrid = HYBRID_WORD_RE.search(output)
    if hybrid:
        raise RuntimeError(
            f"a hanzi is fused into a Vietnamese word ({hybrid.group(0)!r})"
        )

    expansion = len(output) / max(len(source), 1)
    if len(source) >= EXPANSION_MIN_SOURCE_CHARS and expansion < args.min_expansion:
        raise RuntimeError(
            f"output is only {expansion:.2f}x the source; expected at least "
            f"{args.min_expansion:.2f}x"
        )

    source_paragraphs = len([p for p in re.split(r"\n\s*\n", source) if p.strip()])
    output_paragraphs = len([p for p in re.split(r"\n\s*\n", output) if p.strip()])
    if source_paragraphs >= 10 and output_paragraphs < source_paragraphs * args.min_para_fraction:
        raise RuntimeError(
            f"paragraphs collapsed {source_paragraphs} -> {output_paragraphs}"
        )


def check_chapter(name: str, source: str, output: str) -> None:
    leftover = len(CJK_RE.findall(output))
    if leftover:
        logger.warning(f"  {name}: {leftover} Chinese char(s) left — check the file")
    source_paragraphs = len([p for p in re.split(r"\n\s*\n", source) if p.strip()])
    output_paragraphs = len([p for p in re.split(r"\n\s*\n", output) if p.strip()])
    logger.info(
        f"  {name}: ratio {len(output) / max(len(source), 1):.2f}, "
        f"{output_paragraphs}/{source_paragraphs} paragraphs"
    )


async def run_all(todo: list[Path], out_dir: Path, args: argparse.Namespace) -> None:
    codex_bin = resolve_codex_bin(args.codex_bin)
    system = build_system(args)
    semaphore = asyncio.Semaphore(args.concurrency)
    stop = asyncio.Event()
    state = {"done": 0, "request_id": 0}
    failed: list[str] = []

    with tempfile.TemporaryDirectory(prefix="translate-codex-") as raw_temp_dir:
        temp_dir = Path(raw_temp_dir)

        async def one(src: Path) -> None:
            if stop.is_set():
                return
            source = src.read_text(encoding="utf-8").strip()
            if not source:
                return
            title = source.splitlines()[0].strip()
            chunks = chunk_text(source, args.chunk_chars)
            translated: list[str] = []

            for chunk_number, chunk in enumerate(chunks, start=1):
                prompt = USER_TEMPLATE.format(system=system, title=title, chunk=chunk)
                delay = 5.0
                for attempt in range(1, args.retries + 1):
                    if stop.is_set():
                        return
                    try:
                        async with semaphore:
                            state["request_id"] += 1
                            piece = await translate_once(
                                prompt,
                                codex_bin,
                                temp_dir,
                                state["request_id"],
                                args,
                            )
                        validate_piece(chunk, piece, args)
                        break
                    except RateLimited as error:
                        if not stop.is_set():
                            logger.error(f"USAGE LIMIT REACHED — {error}")
                            logger.error(
                                "Stopping. Completed chapters are saved; re-run after reset to resume."
                            )
                            stop.set()
                        return
                    except Exception as error:  # noqa: BLE001 - retry a failed chapter in isolation
                        if attempt == args.retries:
                            failed.append(src.name)
                            logger.error(f"FAILED {src.name}: {error}")
                            return
                        logger.warning(
                            f"  {src.name} chunk {chunk_number}/{len(chunks)} attempt "
                            f"{attempt}/{args.retries} failed ({error}); retrying in {delay:.0f}s"
                        )
                        await asyncio.sleep(delay)
                        delay = min(delay * 2, 120)

                # Stateless chunks after the first may repeat the chapter title.
                if chunk_number > 1:
                    lines = piece.splitlines()
                    if lines and re.match(r"^\s*Chương\s+\d+\s*:", lines[0], re.IGNORECASE):
                        piece = "\n".join(lines[1:]).lstrip()
                translated.append(piece)
                if len(chunks) > 1:
                    logger.info(f"  {src.name}: chunk {chunk_number}/{len(chunks)}")

            body = sanitize("\n\n".join(translated)) + "\n"
            check_chapter(src.name, source, body)
            (out_dir / src.name).write_text(body, encoding="utf-8")
            state["done"] += 1
            logger.info(f"[{state['done']}/{len(todo)}] {src.name} — {len(body):,} chars")

        await asyncio.gather(*(one(path) for path in todo))

    logger.info(f"Done: {state['done']} translated, {len(failed)} failed")
    if failed:
        logger.warning(f"Re-run the same command to retry {len(failed)} failure(s): {failed[:10]}")


def run(args: argparse.Namespace) -> None:
    in_dir, out_dir = Path(args.input), Path(args.out)
    if not in_dir.is_dir():
        raise SystemExit(f"No such directory: {in_dir}")
    if args.concurrency < 1:
        raise SystemExit("--concurrency must be at least 1")
    if args.retries < 1:
        raise SystemExit("--retries must be at least 1")

    files = sorted(in_dir.glob("*.txt"))
    if args.limit:
        files = files[: args.limit]
    if not files:
        raise SystemExit(f"No .txt files in {in_dir}")

    todo = [
        path
        for path in files
        if args.force
        or not ((out_dir / path.name).exists() and (out_dir / path.name).stat().st_size > 0)
    ]
    skipped = len(files) - len(todo)
    chunks = sum(
        len(chunk_text(path.read_text(encoding="utf-8").strip(), args.chunk_chars))
        for path in todo
    )

    # Resolve during dry runs too, so setup problems are reported immediately.
    codex_bin = resolve_codex_bin(args.codex_bin)
    model = args.model or "Codex CLI default"
    logger.info(
        f"{len(files)} chapter file(s); {skipped} already translated, {len(todo)} to do "
        f"-> {chunks} Codex call(s)"
    )
    logger.info(f"CLI: {codex_bin}; model: {model}; reasoning effort: {args.effort}")
    logger.info(
        f"~{args.seconds_each}s each at --concurrency {args.concurrency} "
        f"~= {chunks * args.seconds_each / args.concurrency / 3600:.1f}h wall clock"
    )
    logger.info("Uses the account authenticated by Codex CLI and counts against its usage limits.")

    if not args.apply:
        logger.info("DRY RUN — nothing sent, nothing written. Re-run with --apply.")
        logger.info("Tip: --limit 2 --apply first to inspect quality before the full run.")
        return
    if not todo:
        logger.info("Nothing to do.")
        return

    out_dir.mkdir(parents=True, exist_ok=True)
    asyncio.run(run_all(todo, out_dir, args))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="directory of Chinese chapter .txt files")
    parser.add_argument("-o", "--out", required=True, help="directory for Vietnamese output")
    parser.add_argument(
        "--model",
        help="Codex model ID; omitted uses the CLI's current default",
    )
    parser.add_argument(
        "--effort",
        choices=["minimal", "low", "medium", "high", "xhigh"],
        default="low",
        help="reasoning effort (default: low)",
    )
    parser.add_argument(
        "--genre",
        choices=sorted(GENRES),
        default="xianxia",
        help="terminology/honorifics set; use 'fantasy' for magic-and-knights books",
    )
    parser.add_argument(
        "--quote-style",
        choices=sorted(QUOTE_RULES),
        default="curly",
        help="dialogue quote marks (default: curly)",
    )
    parser.add_argument(
        "--title-case",
        choices=sorted(TITLE_CASE_RULES),
        default="title",
        help="chapter-heading capitalisation (default: title)",
    )
    parser.add_argument("--concurrency", type=int, default=2, help="parallel chapters (default: 2)")
    parser.add_argument("--chunk-chars", type=int, default=CHUNK_CHARS, help=f"default: {CHUNK_CHARS}")
    parser.add_argument("--retries", type=int, default=4, help="attempts per chunk (default: 4)")
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=600,
        help="timeout for one Codex call (default: 600)",
    )
    parser.add_argument("--limit", type=int, help="only process the first N chapters (test runs)")
    parser.add_argument("--force", action="store_true", help="re-translate chapters already done")
    parser.add_argument("--glossary", help="path to glossary.json")
    parser.add_argument("--max-glossary-terms", type=int, default=500, help="default: 500")
    parser.add_argument("--style-cn", action="append", help="Chinese chapter used as a style example")
    parser.add_argument("--style-vi", action="append", help="approved Vietnamese match for --style-cn")
    parser.add_argument("--style-paras", type=int, default=8, help="paragraphs per example (default: 8)")
    parser.add_argument(
        "--min-expansion",
        type=float,
        default=MIN_EXPANSION,
        help=f"retry if VI/source character ratio is lower (default: {MIN_EXPANSION})",
    )
    parser.add_argument(
        "--min-para-fraction",
        type=float,
        default=MIN_PARA_FRACTION,
        help=f"retry if too many paragraphs collapse (default: {MIN_PARA_FRACTION})",
    )
    parser.add_argument("--codex-bin", default="codex", help="Codex executable (default: codex)")
    parser.add_argument(
        "--keep-user-config",
        action="store_true",
        help="load ~/.codex/config.toml (default: isolate translation from user config)",
    )
    parser.add_argument(
        "--seconds-each",
        type=int,
        default=90,
        help="per-call estimate used only for dry-run ETA (default: 90)",
    )
    parser.add_argument("--apply", action="store_true", help="actually run (default: dry run)")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
