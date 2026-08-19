"""Build a Chinese→Vietnamese glossary from already-approved chapter translations.

Pairs each file in the Vietnamese reference dir with the same-named file in the
Chinese dir, asks DeepSeek to extract the proper nouns and cultivation terms it
sees in both, and merges the results into one glossary.json.

Feed that glossary to translate_chapters_deepseek.py so names stay identical to
the translation readers have already seen.

Usage (from backend/):
    python -m scripts.build_glossary_deepseek work/cn work/vi_ref -o work/glossary.json
    python -m scripts.build_glossary_deepseek work/cn work/vi_ref -o work/glossary.json --apply
"""
import argparse
import asyncio
import json
import logging
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from openai import AsyncOpenAI

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("build_glossary")

DEEPSEEK_BASE_URL = "https://api.deepseek.com"

EXTRACT_PROMPT = """Bạn nhận được một chương truyện tiên hiệp bằng tiếng Trung và bản dịch tiếng Việt ĐÃ ĐƯỢC DUYỆT của chính chương đó.

Nhiệm vụ: trích xuất bảng đối chiếu thuật ngữ giữa hai bản, gồm:
- Tên nhân vật
- Tên môn phái, gia tộc, tông môn
- Địa danh (quốc gia, sơn mạch, thành trì)
- Tên công pháp, trận pháp, pháp bảo, đan dược, vũ khí
- Thuật ngữ tu luyện và cảnh giới

KHÔNG đưa vào các từ thông thường (động từ, tính từ, danh từ chung như "thanh kiếm", "ngọn núi").

Chỉ trả về JSON hợp lệ, dạng một object phẳng: khóa là chuỗi tiếng Trung, giá trị là cách dịch tiếng Việt xuất hiện trong bản dịch đã duyệt. Không giải thích, không markdown, không dấu ```.

Ví dụ định dạng:
{"林清": "Lâm Thanh", "练气": "Luyện Khí", "玄木阵": "Huyền Mộc Trận"}"""


def strip_fence(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        s = s.rsplit("```", 1)[0]
    return s.strip()


async def extract_pair(
    client: AsyncOpenAI, model: str, cn: Path, vi: Path, max_chars: int, retries: int
) -> dict[str, str]:
    cn_text = cn.read_text(encoding="utf-8")[:max_chars]
    vi_text = vi.read_text(encoding="utf-8")[: max_chars * 3]
    user = f"--- Nguyên tác tiếng Trung ---\n{cn_text}\n\n--- Bản dịch tiếng Việt đã duyệt ---\n{vi_text}"
    delay = 2.0
    for attempt in range(1, retries + 1):
        try:
            resp = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": EXTRACT_PROMPT},
                    {"role": "user", "content": user},
                ],
                temperature=0.2,
                max_tokens=4000,
                response_format={"type": "json_object"},
            )
            data = json.loads(strip_fence(resp.choices[0].message.content or "{}"))
            return {
                str(k).strip(): str(v).strip()
                for k, v in data.items()
                if str(k).strip() and str(v).strip()
            }
        except Exception as e:  # noqa: BLE001
            if attempt == retries:
                logger.error(f"FAILED {cn.name}: {e}")
                return {}
            logger.warning(f"  {cn.name} attempt {attempt}/{retries} failed ({e}); retry in {delay:.0f}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)
    return {}


async def run(args: argparse.Namespace) -> None:
    cn_dir, vi_dir, out = Path(args.cn_dir), Path(args.vi_dir), Path(args.out)
    refs = sorted(p for p in vi_dir.glob("*.txt"))
    pairs = [(cn_dir / p.name, p) for p in refs if (cn_dir / p.name).is_file()]
    orphans = [p.name for p in refs if not (cn_dir / p.name).is_file()]
    if orphans:
        logger.warning(f"{len(orphans)} reference file(s) have no Chinese match: {orphans[:5]}")
    if not pairs:
        raise SystemExit(f"No matching filenames between {cn_dir} and {vi_dir}")

    logger.info(f"{len(pairs)} aligned pair(s): {[p[1].name for p in pairs]}")
    if not args.apply:
        logger.info("DRY RUN — no API calls. Re-run with --apply.")
        return

    api_key = args.api_key or os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        try:
            from app.config import settings

            api_key = getattr(settings, "deepseek_api_key", None)
        except Exception:  # noqa: BLE001
            api_key = None
    if not api_key:
        raise SystemExit("Set DEEPSEEK_API_KEY in backend/.env (or pass --api-key)")

    client = AsyncOpenAI(api_key=api_key, base_url=DEEPSEEK_BASE_URL, timeout=300.0)
    results = await asyncio.gather(
        *(extract_pair(client, args.model, cn, vi, args.max_chars, args.retries) for cn, vi in pairs)
    )

    # A term can be rendered differently in different chapters — keep the most common.
    votes: dict[str, Counter] = defaultdict(Counter)
    for res in results:
        for cn_term, vi_term in res.items():
            votes[cn_term][vi_term] += 1

    merged = {cn: c.most_common(1)[0][0] for cn, c in sorted(votes.items())}
    conflicts = {cn: dict(c) for cn, c in votes.items() if len(c) > 1}

    if out.exists() and not args.overwrite:
        existing = json.loads(out.read_text(encoding="utf-8"))
        added = {k: v for k, v in merged.items() if k not in existing}
        merged = {**existing, **added}
        logger.info(f"Merged into existing glossary: {len(added)} new term(s)")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(merged, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    logger.info(f"Wrote {len(merged)} term(s) to {out}")
    if conflicts:
        logger.warning(
            f"{len(conflicts)} term(s) had conflicting translations across chapters — "
            "most common kept, review these by hand:"
        )
        for cn_term, opts in list(conflicts.items())[:15]:
            logger.warning(f"   {cn_term}: {opts}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cn_dir", help="directory of Chinese chapter files")
    ap.add_argument("vi_dir", help="directory of approved Vietnamese files (same filenames)")
    ap.add_argument("-o", "--out", required=True, help="glossary.json path")
    ap.add_argument("--model", default="deepseek-chat")
    ap.add_argument("--max-chars", type=int, default=6000, help="Chinese chars per chapter sent")
    ap.add_argument("--retries", type=int, default=5)
    ap.add_argument("--overwrite", action="store_true", help="replace instead of merging")
    ap.add_argument("--api-key", help="override DEEPSEEK_API_KEY")
    ap.add_argument("--apply", action="store_true", help="actually call the API")
    args = ap.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
