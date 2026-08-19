"""Translate split Chinese chapter files to Vietnamese (xianxia tone) via Claude.

Same contract as scripts.translate_chapters_deepseek (same input dir, same output
dir, same glossary + style-example flags) — swap one for the other freely.

Two modes:
  --batch  Message Batches API. Half price, results within ~1h. Best for a
           whole book. Resumable: the batch id is saved, so a re-run polls the
           existing batch instead of paying for it twice.
  (live)   Async streaming requests with a concurrency cap. Use for --limit
           spot-checks where you want output immediately.

Both share one constant system prompt (rules + glossary + style examples) marked
`cache_control`, so it is billed at ~0.1x after the first call.

Setup: pip install anthropic, then set ANTHROPIC_API_KEY in backend/.env

Usage (from backend/):
    python -m scripts.translate_chapters_claude ../work/cn -o ../work/vi        # dry run + cost
    python -m scripts.translate_chapters_claude ../work/cn -o ../work/vi --limit 2 --apply
    python -m scripts.translate_chapters_claude ../work/cn -o ../work/vi --batch --apply
"""
import argparse
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from anthropic import Anthropic, AsyncAnthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

from scripts.translate_chapters_deepseek import (
    CJK_RE,
    build_style_block,
    build_system_prompt,
    chunk_text,
)

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("translate_claude")

DEFAULT_MODEL = "claude-opus-4-8"

# A chapter is ~2k Chinese chars, so one request per chapter is normal — chunking
# only kicks in for outliers. (DeepSeek needed ~1.2k chunks; Claude does not.)
CHUNK_CHARS = 12000
MAX_TOKENS = 16000

# Minimum cacheable prefix per model. A system prompt shorter than this silently
# will NOT cache — no error, just cache_creation_input_tokens: 0.
CACHE_MINIMUMS = {
    "claude-opus-4-8": 4096,
    "claude-opus-4-7": 4096,
    "claude-opus-4-6": 4096,
    "claude-haiku-4-5": 4096,
    "claude-sonnet-4-6": 2048,
    "claude-fable-5": 2048,
}

# Published rates, USD per 1M tokens. Batches bill at 50%.
PRICING = {
    "claude-opus-4-8": (5.00, 25.00),
    "claude-opus-4-7": (5.00, 25.00),
    "claude-sonnet-5": (3.00, 15.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
}

USER_TEMPLATE = (
    '[Bối cảnh: chương "{title}"]\n\n'
    "Dịch toàn bộ đoạn sau sang tiếng Việt:\n\n{chunk}"
)


def build_system(args: argparse.Namespace) -> list[dict]:
    """One constant system prompt for every request, marked for caching."""
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

    text = build_system_prompt(
        glossary, args.max_glossary_terms, build_style_block(pairs, args.style_paras)
    )

    # ~1 token per 2 chars is a deliberately conservative floor for mixed
    # Vietnamese/Chinese prompt text — it under-estimates, so the warning fires
    # early rather than late.
    approx_tokens = len(text) // 2
    minimum = CACHE_MINIMUMS.get(args.model)
    if minimum and approx_tokens < minimum:
        logger.warning(
            f"System prompt is ~{approx_tokens} tokens but {args.model} needs "
            f">={minimum} to cache — caching will silently no-op. Raise --style-paras "
            "(more example text) or add glossary terms to cross the threshold."
        )
    else:
        logger.info(f"System prompt ~{approx_tokens} tokens ({len(text):,} chars), cacheable")

    return [
        {
            "type": "text",
            "text": text,
            # 1h TTL: a batch takes up to an hour, and a 5m entry would expire
            # mid-run and be re-written repeatedly.
            "cache_control": {"type": "ephemeral", "ttl": "1h"},
        }
    ]


def build_requests(files: list[Path], args: argparse.Namespace) -> list[dict]:
    """One entry per (chapter, chunk): custom_id, source path, user message."""
    out = []
    for n, src in enumerate(files):
        text = src.read_text(encoding="utf-8").strip()
        if not text:
            continue
        title = text.splitlines()[0].strip()
        chunks = chunk_text(text, args.chunk_chars)
        for c, chunk in enumerate(chunks):
            out.append(
                {
                    # Batch custom_id is capped at 64 chars — never use the
                    # Chinese filename here. The map back to a path is `src`.
                    "custom_id": f"ch{n:04d}-p{c:02d}",
                    "src": src,
                    "part": c,
                    "parts": len(chunks),
                    "user": USER_TEMPLATE.format(title=title, chunk=chunk),
                }
            )
    return out


def message_params(req: dict, system: list[dict], args: argparse.Namespace) -> dict:
    params: dict = {
        "model": args.model,
        "max_tokens": args.max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": req["user"]}],
    }
    if args.thinking == "adaptive":
        params["thinking"] = {"type": "adaptive"}
        params["output_config"] = {"effort": args.effort}
    else:
        params["thinking"] = {"type": "disabled"}
    return params


def check_text(name: str, text: str, stop_reason: str | None) -> None:
    if stop_reason == "max_tokens":
        logger.warning(f"  {name}: hit max_tokens — output is truncated, raise --max-tokens")
    leftover = len(CJK_RE.findall(text))
    if leftover:
        logger.warning(
            f"  {name}: {leftover} Chinese char(s) left in the translation — "
            "TTS will read these wrong, check the file"
        )


def write_chapter(out_dir: Path, src: Path, parts: dict[int, str]) -> int:
    body = "\n\n".join(parts[i] for i in sorted(parts)).strip() + "\n"
    (out_dir / src.name).write_text(body, encoding="utf-8")
    return len(body)


def get_client(args: argparse.Namespace, is_async: bool):
    key = args.api_key or os.getenv("ANTHROPIC_API_KEY")
    if not key:
        # A zero-arg client also resolves ANTHROPIC_AUTH_TOKEN or an
        # `ant auth login` profile, so an unset env var is not fatal.
        logger.info("No ANTHROPIC_API_KEY — falling back to SDK credential resolution")
        return AsyncAnthropic() if is_async else Anthropic()
    return AsyncAnthropic(api_key=key) if is_async else Anthropic(api_key=key)


# --------------------------------------------------------------------------- #
# Batch mode
# --------------------------------------------------------------------------- #

def run_batch(reqs: list[dict], system: list[dict], out_dir: Path, args: argparse.Namespace) -> None:
    client = get_client(args, is_async=False)
    state_path = out_dir / "_batch.json"

    if state_path.exists() and not args.new_batch:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        batch_id = state["batch_id"]
        logger.info(f"Resuming existing batch {batch_id} (--new-batch to submit a fresh one)")
    else:
        batch = client.messages.batches.create(
            requests=[
                Request(
                    custom_id=r["custom_id"],
                    params=MessageCreateParamsNonStreaming(**message_params(r, system, args)),
                )
                for r in reqs
            ]
        )
        batch_id = batch.id
        state_path.write_text(
            json.dumps({"batch_id": batch_id, "count": len(reqs)}, indent=1), encoding="utf-8"
        )
        logger.info(f"Submitted batch {batch_id} with {len(reqs)} request(s)")

    while True:
        batch = client.messages.batches.retrieve(batch_id)
        if batch.processing_status == "ended":
            break
        c = batch.request_counts
        logger.info(
            f"  {batch.processing_status}: {c.succeeded} ok / {c.errored} err / "
            f"{c.processing} processing"
        )
        time.sleep(args.poll_seconds)

    c = batch.request_counts
    logger.info(f"Batch ended: {c.succeeded} succeeded, {c.errored} errored, {c.expired} expired")

    by_id = {r["custom_id"]: r for r in reqs}
    chapters: dict[Path, dict[int, str]] = {}
    failed: list[str] = []

    for result in client.messages.batches.results(batch_id):
        req = by_id.get(result.custom_id)
        if req is None:
            continue
        if result.result.type != "succeeded":
            failed.append(result.custom_id)
            logger.error(f"FAILED {req['src'].name} part {req['part']}: {result.result.type}")
            continue
        msg = result.result.message
        if msg.stop_reason == "refusal":
            failed.append(result.custom_id)
            logger.error(f"REFUSED {req['src'].name} part {req['part']}")
            continue
        text = "\n\n".join(b.text for b in msg.content if b.type == "text").strip()
        check_text(f"{req['src'].name}#{req['part']}", text, msg.stop_reason)
        chapters.setdefault(req["src"], {})[req["part"]] = text

    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for src, parts in chapters.items():
        expected = next(r["parts"] for r in reqs if r["src"] == src)
        if len(parts) != expected:
            logger.warning(f"  {src.name}: only {len(parts)}/{expected} parts returned, skipping")
            continue
        write_chapter(out_dir, src, parts)
        written += 1

    logger.info(f"Wrote {written} chapter file(s) to {out_dir}")
    if failed:
        logger.warning(
            f"{len(failed)} request(s) failed. Re-run with --new-batch to retry "
            f"only the still-missing chapters: {failed[:10]}"
        )


# --------------------------------------------------------------------------- #
# Live mode
# --------------------------------------------------------------------------- #

async def run_live(reqs: list[dict], system: list[dict], out_dir: Path, args: argparse.Namespace) -> None:
    client = get_client(args, is_async=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(args.concurrency)
    chapters: dict[Path, dict[int, str]] = {}
    failed: list[str] = []
    done = 0

    async def one(req: dict) -> None:
        nonlocal done
        async with sem:
            try:
                # Stream so a long chapter can't trip the request timeout.
                async with client.messages.stream(
                    **message_params(req, system, args)
                ) as stream:
                    msg = await stream.get_final_message()
            except Exception as e:  # noqa: BLE001 — one bad chapter shouldn't kill the run
                failed.append(req["custom_id"])
                logger.error(f"FAILED {req['src'].name} part {req['part']}: {e}")
                return
        if msg.stop_reason == "refusal":
            failed.append(req["custom_id"])
            logger.error(f"REFUSED {req['src'].name} part {req['part']}")
            return
        text = "\n\n".join(b.text for b in msg.content if b.type == "text").strip()
        check_text(f"{req['src'].name}#{req['part']}", text, msg.stop_reason)
        chapters.setdefault(req["src"], {})[req["part"]] = text
        done += 1
        u = msg.usage
        logger.info(
            f"[{done}/{len(reqs)}] {req['src'].name} part {req['part'] + 1}/{req['parts']} "
            f"— in {u.input_tokens} / cache-read {u.cache_read_input_tokens} / out {u.output_tokens}"
        )

    await asyncio.gather(*(one(r) for r in reqs))

    written = 0
    for src, parts in chapters.items():
        expected = next(r["parts"] for r in reqs if r["src"] == src)
        if len(parts) != expected:
            logger.warning(f"  {src.name}: only {len(parts)}/{expected} parts returned, skipping")
            continue
        write_chapter(out_dir, src, parts)
        written += 1
    logger.info(f"Wrote {written} chapter file(s); {len(failed)} request(s) failed")


# --------------------------------------------------------------------------- #

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

    system = build_system(args)
    reqs = build_requests(todo, args)

    src_chars = sum(len(r["user"]) for r in reqs)
    sys_chars = len(system[0]["text"])
    # Chinese is ~1 token/char; the system prompt is mostly Vietnamese at ~1/2.
    in_fresh = src_chars
    in_cached = (sys_chars // 2) * len(reqs)
    out_tok = int(src_chars * 1.6)  # Vietnamese output runs ~3.4x the chars, ~1.6x the tokens

    p_in, p_out = PRICING.get(args.model, (5.00, 25.00))
    discount = 0.5 if args.batch else 1.0
    cost = (
        (in_fresh / 1e6) * p_in
        + (in_cached / 1e6) * p_in * 0.1  # cache reads bill at ~0.1x
        + (out_tok / 1e6) * p_out
    ) * discount

    logger.info(
        f"{len(files)} chapter file(s); {skipped} already translated, {len(todo)} to do "
        f"→ {len(reqs)} request(s)"
    )
    logger.info(
        f"Rough estimate on {args.model}{' (batch, 50% off)' if args.batch else ''}: "
        f"~{in_fresh:,} fresh input + ~{in_cached:,} cached input + ~{out_tok:,} output tokens "
        f"≈ ${cost:.2f} (check current pricing)"
    )

    if not args.apply:
        logger.info("DRY RUN — nothing sent, nothing written. Re-run with --apply.")
        logger.info("Tip: --limit 2 --apply first to eyeball the tone before the full run.")
        return
    if not reqs:
        logger.info("Nothing to do.")
        return

    if args.batch:
        run_batch(reqs, system, out_dir, args)
    else:
        asyncio.run(run_live(reqs, system, out_dir, args))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", help="directory of Chinese chapter .txt files")
    ap.add_argument("-o", "--out", required=True, help="directory for Vietnamese output")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"default: {DEFAULT_MODEL}")
    ap.add_argument(
        "--batch",
        action="store_true",
        help="use the Message Batches API (50%% cheaper, results within ~1h)",
    )
    ap.add_argument(
        "--new-batch", action="store_true", help="submit a fresh batch instead of resuming"
    )
    ap.add_argument("--poll-seconds", type=int, default=60, help="batch poll interval (default: 60)")
    ap.add_argument(
        "--thinking",
        choices=["adaptive", "disabled"],
        default="adaptive",
        help="adaptive keeps names consistent and stops reasoning leaking into the "
        "chapter text; disabled is cheaper (default: adaptive)",
    )
    ap.add_argument(
        "--effort",
        choices=["low", "medium", "high", "xhigh", "max"],
        default="low",
        help="thinking depth when --thinking adaptive (default: low)",
    )
    ap.add_argument("--concurrency", type=int, default=4, help="live mode only (default: 4)")
    ap.add_argument("--chunk-chars", type=int, default=CHUNK_CHARS, help=f"default: {CHUNK_CHARS}")
    ap.add_argument("--max-tokens", type=int, default=MAX_TOKENS, help=f"default: {MAX_TOKENS}")
    ap.add_argument("--limit", type=int, help="only process the first N chapters (test runs)")
    ap.add_argument("--force", action="store_true", help="re-translate chapters already done")
    ap.add_argument("--glossary", help="path to glossary.json")
    ap.add_argument("--max-glossary-terms", type=int, default=300, help="default: 300")
    ap.add_argument("--style-cn", action="append", help="Chinese chapter used as a style example")
    ap.add_argument("--style-vi", action="append", help="approved Vietnamese match for --style-cn")
    ap.add_argument("--style-paras", type=int, default=8, help="paragraphs per example (default: 8)")
    ap.add_argument("--api-key", help="override ANTHROPIC_API_KEY")
    ap.add_argument("--apply", action="store_true", help="actually call the API (default: dry run)")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
