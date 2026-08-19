"""Translate split Chinese chapter files to Vietnamese (xianxia tone) via DeepSeek.

Reads the folder produced by scripts.split_book_chapters, sends each chapter to
DeepSeek (OpenAI-compatible API), writes one Vietnamese .txt per chapter.

Resumable: a chapter whose output file already exists and is non-empty is
skipped, so you can stop and re-run at any time. Use --force to redo.

Setup: put DEEPSEEK_API_KEY=sk-... in backend/.env

Usage (from backend/):
    python -m scripts.translate_chapters_deepseek out/cn -o out/vi            # dry run
    python -m scripts.translate_chapters_deepseek out/cn -o out/vi --limit 2 --apply
    python -m scripts.translate_chapters_deepseek out/cn -o out/vi --apply
    python -m scripts.translate_chapters_deepseek out/cn -o out/vi --glossary out/glossary.json --apply
"""
import argparse
import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path

# Make `app.*` imports work when run as `python -m scripts.…`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from openai import AsyncOpenAI

# The Windows console defaults to a legacy codepage and would print the Chinese
# filenames and Vietnamese diacritics as escapes.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("translate_chapters")

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-flash"

# Translate a WHOLE chapter in one request. Splitting a chapter into several
# independent calls was the single worst quality bug in this pipeline: each call
# saw only its own fragment, so it re-emitted the chapter heading (one chapter
# came back with four differently-translated headings), re-invented character
# names between fragments (Nữ Tướng / Nữ Tiếu / Nữ Sướt for one character), and
# switched dialogue punctuation halfway through. Nothing downstream can repair
# that — the fragments simply never agreed with each other.
#
# deepseek-v4-flash accepts max_tokens up to 128k (probed), and the longest
# chapter here is ~11.1k hanzi, so one call per chapter always fits. Fewer, larger
# requests are also cheaper: the system prompt is resent 1.3k times, not 4.7k.
# Chapters longer than this still split, so the seam logic below stays in place.
CHUNK_CHARS = 12000
MAX_OUTPUT_TOKENS = 48000

CJK_RE = re.compile(r"[一-鿿㐀-䶿]")
# A faithful Vietnamese translation contains no hanzi at all. Anything above this
# fraction means the model handed back the source text rather than a translation.
ECHO_CJK_THRESHOLD = 0.10
# Per-paragraph guard for partial echoes. Looser than the whole-response check
# because a lone transliterated term can leave a short line legitimately dense;
# the minimum length keeps one-word lines from tripping it.
ECHO_PARA_CJK_THRESHOLD = 0.30
ECHO_MIN_PARA_CHARS = 25
# A hanzi fused into a Vietnamese word ("ngọc ph符" for "ngọc phù") is worse than
# a standalone stray character: it corrupts the word itself and is far too small
# for the paragraph guard to notice. Detect a hanzi touching a Latin letter.
HYBRID_WORD_RE = re.compile(r"(?:[A-Za-zÀ-ỹ][一-鿿㐀-䶿])|(?:[一-鿿㐀-䶿][A-Za-zÀ-ỹ])")
# The model sometimes stops early WITHOUT setting finish_reason='length' — it
# simply ends, occasionally mid-word. Chinese→Vietnamese runs ~3.3x in
# characters across this book, so anything under this floor lost content.
MIN_EXPANSION = 1.8
# Short "chapters" here are author's notes and prize/winner lists (names, counts,
# punctuation) that legitimately do not expand — applying the ratio floor to them
# rejects a correct translation forever. Only guard real prose.
EXPANSION_MIN_SOURCE_CHARS = 1200
# Structure guard: the model also likes to fuse many short source paragraphs
# into a few huge ones (one chapter went 233 paragraphs -> 7 while keeping a
# normal character count). That destroys the blank-line boundaries the reader
# renders and the TTS chunker splits on, so treat it as a failed translation.
MIN_PARA_FRACTION = 0.60
SENTENCE_END_RE = re.compile(r"(?<=[。！？!?…；;])")

# Instructions are in English on purpose — the model follows English directives
# more precisely than Vietnamese ones, while still producing native Vietnamese.
# Kept byte-identical across every request so DeepSeek's automatic prefix cache
# hits on all but the first call.
SYSTEM_PROMPT = """You are a professional translator specializing in Chinese-to-Vietnamese translation of {GENRE_LINE}.

The translation will be READ ALOUD by a Vietnamese text-to-speech engine, so every choice must account for how it sounds, not just how it reads.

Rules:

1. Translate faithfully and completely. Do not summarize, omit, add, embellish, or comment. Do not "improve" the original — its pacing and level of detail are deliberate.

2. MOST IMPORTANT RULE — write ordinary Vietnamese, not Hán-Việt transliteration.
   Hán-Việt readings are allowed in exactly two places: proper nouns (rule 3) and the fixed genre-terminology list (rule 4). EVERYTHING else — ordinary nouns, verbs, adjectives, narration, description, emotion, idiom — must be translated into the plain modern Vietnamese an ordinary reader uses and understands.
   Never invent a Hán-Việt compound for a word that has a normal Vietnamese equivalent. Translate the MEANING:
     郁色 → "vẻ u uất" / "nét ủ dột"     NOT "u sắc"
     加持 → "tăng cường" / "hỗ trợ"       NOT "gia trì"
     天光 → "ánh sáng trời"               NOT "thiên quang"
     出一口气 → "trút giận" / "rửa hận"    NOT "xả một hơi"
     沾光 → "được thơm lây"               NOT "nhờ vả"
     收获 → "thu được gì"                 NOT "thu hoạch"
     福缘深厚 → "phúc phần sâu dày"        NOT "phúc duyên thâm hậu"
   The test for every sentence: would a Vietnamese reader who knows no Chinese understand it immediately? If not, rewrite it in ordinary words. This matters more than sounding classical.

3. Proper nouns — CRITICAL, because TTS will pronounce them aloud:
   a. Render names of people, clans, sects, places, techniques, and artifacts in their Hán-Việt reading.
   b. Transliterate, do not translate the meaning: 林动 → "Lâm Động", never "Rừng Động".
   c. Each character, sect, clan, place, technique, and artifact uses ONE spelling, identical across all chapters.
   d. Where several readings exist, pick the common, easy-to-pronounce, classical-sounding one.
   e. Never leave a Chinese character anywhere in the output — but the fix is a Vietnamese translation, not a Hán-Việt coinage, unless it is a proper noun.

4. {TERM_RULE}

5. {HONORIFIC_RULE}

6. {ATMOSPHERE_RULE}

7. Render idioms and proverbs with an equivalent Vietnamese expression where one exists; otherwise translate so the meaning is plain. Never transliterate a four-character idiom into Hán-Việt and leave it unexplained.

8. Must sound correct when spoken (TTS-friendly):
   a. Spell digits inside names and titles as words ("đệ tử số 7" → "đệ tử số bảy").
   b. Delete decorative characters, asterisks, repeated punctuation, and stray unicode symbols — TTS reads them as noise.
   c. Avoid abbreviations that TTS would mispronounce.

9. Keep the source paragraph structure: one blank line between paragraphs, dialogue on its own line. Do not number paragraphs or invent headings.
   Dialogue punctuation must be ONE style for the whole chapter: {QUOTE_RULE}. Never mix quote marks with dashes, and never switch style partway through a chapter.

10. The chapter heading must be TRANSLATED, never left in Chinese. Keep its numbering but render it in Vietnamese as "Chương <number>: <Vietnamese title>". A title that is a proper noun is transliterated; a title that is an ordinary word is translated into ordinary Vietnamese, exactly as in rule 2:
   第2章 李家 → "Chương 2: Lý Gia"            (proper noun — transliterate)
   第3章 鉴子 → "Chương 3: Giám Tử"           (proper noun — transliterate)
   第1291章 诀窍 → "Chương 1291: Bí Quyết"    (ordinary word — translate, NOT "Quyết Khiếu")
   第330章 试马 → "Chương 330: Thử Ngựa"      (ordinary words — translate, NOT "Thí Mã")
   楔子 → "Chương mở đầu"
   {TITLE_CASE_RULE} Never emit "第", "章", or any other Chinese character in the heading.

11. Output the Vietnamese translation only. No preamble, notes, explanations, or restatement of the original."""


MD_EMPHASIS_RE = re.compile(r"[*_]{1,3}(?=\S)(.+?)(?<=\S)[*_]{1,3}", re.DOTALL)
CJK_BRACKET_RE = re.compile(r"[《》〈〉「」『』【】]")


def sanitize(text: str) -> str:
    """Strip markup the Vietnamese TTS would read aloud as noise.

    The model likes to render 《书名》 as *Tên Sách* — markdown emphasis that the
    reader shows literally and edge-tts pronounces. Prompt rule 7b asks it not
    to, but over thousands of calls it slips, so enforce it deterministically.
    """
    text = MD_EMPHASIS_RE.sub(r"\1", text)
    text = CJK_BRACKET_RE.sub("", text)
    # Collapse the blank-line runs that stripping can leave behind.
    return re.sub(r"\n{3,}", "\n\n", text).strip()


class Usage:
    """Running total of what the API actually billed, as reported per response.

    The pre-run estimate has to guess how far Chinese expands into Vietnamese;
    this replaces the guess with the real numbers once a run has happened.
    """

    def __init__(self) -> None:
        self.calls = 0
        self.prompt = 0
        self.completion = 0
        self.cache_hit = 0
        self.cache_miss = 0

    def add(self, u: object) -> None:
        if u is None:
            return
        self.calls += 1
        self.prompt += getattr(u, "prompt_tokens", 0) or 0
        self.completion += getattr(u, "completion_tokens", 0) or 0
        # DeepSeek-specific fields; absent on other OpenAI-compatible backends.
        self.cache_hit += getattr(u, "prompt_cache_hit_tokens", 0) or 0
        self.cache_miss += getattr(u, "prompt_cache_miss_tokens", 0) or 0

    def cost(self, price_cached: float, price_in: float, price_out: float) -> float:
        # Fall back to billing all prompt tokens at the miss rate if the backend
        # didn't break out cache hits, so cost is never silently understated.
        hit, miss = self.cache_hit, self.cache_miss
        if hit + miss == 0:
            hit, miss = 0, self.prompt
        return (
            (hit / 1e6) * price_cached
            + (miss / 1e6) * price_in
            + (self.completion / 1e6) * price_out
        )


def approx_tokens(text: str) -> int:
    """Rough token count for a mixed English/Vietnamese/Chinese string.

    A hanzi is about one token; Latin-script text runs closer to 3.5 chars per
    token. Good enough to size the cached prefix — not a substitute for the
    usage numbers the API returns.
    """
    cjk = len(CJK_RE.findall(text))
    return cjk + int((len(text) - cjk) / 3.5)


def head_paragraphs(path: Path, count: int) -> str:
    """First `count` non-empty paragraphs of a chapter file, heading included."""
    paras = [p.strip() for p in re.split(r"\n\s*\n", path.read_text(encoding="utf-8")) if p.strip()]
    return "\n\n".join(paras[:count])


def build_style_block(pairs: list[tuple[Path, Path]], paras: int) -> str:
    """Few-shot CN→VI excerpts from already-approved chapters.

    The same block is prepended to every request, so DeepSeek's automatic context
    caching makes the repeat cheap after the first call.
    """
    if not pairs:
        return ""
    blocks = []
    for cn_path, vi_path in pairs:
        blocks.append(
            "--- Nguyên tác ---\n"
            f"{head_paragraphs(cn_path, paras)}\n\n"
            "--- Bản dịch mẫu (đã duyệt) ---\n"
            f"{head_paragraphs(vi_path, paras)}"
        )
    return (
        "\n\nREQUIRED STYLE REFERENCE — the following are approved translations from this "
        "same novel. Match their voice, sentence rhythm, forms of address, and proper-noun "
        "transliteration exactly:\n\n" + "\n\n".join(blocks)
    )


# House style differs per book, and a continuation must match the chapters already
# published. 玄鉴仙族 uses curly quotes + Title Case headings; the Lâm Thanh book
# uses straight quotes + sentence case. Getting these wrong makes chapter 61 look
# visibly unlike chapter 60, which no downstream step can repair.
# Not every Chinese web novel is xianxia. 恶魔法则 is Western-style fantasy —
# 魔法 appears 8,778 times and 修炼 only 228 — so a cultivation-term whitelist
# would push knights and dukes into "luyện khí / kim đan" vocabulary and address
# them as "đạo hữu". Genre swaps the terminology, honorifics and atmosphere.
GENRES = {
    "xianxia": {
        "genre_line": "xianxia/wuxia web novels",
        "term_rule": (
            "Keep cultivation terminology as established Vietnamese xianxia terms — never "
            "translate them literally: luyện khí, trúc cơ, tử phủ, kim đan, nguyên anh, hóa "
            "thần, độ kiếp, linh căn, linh khí, linh thạch, đan điền, kinh mạch, tu vi, cảnh "
            "giới, đột phá, pháp bảo, pháp khí, linh bảo, công pháp, thần thức, nguyên thần, "
            "tâm ma, cấm chế, trận pháp, truyền tống trận, phi thăng, đoạt xá. Vietnamese "
            "xianxia readers know these. Do not extend the list by coining NEW Hán-Việt "
            "compounds for ordinary words — that is rule 2's job."
        ),
        "honorific_rule": (
            "Keep honorifics and forms of address consistent and period-appropriate: ta / "
            "ngươi / hắn / nàng / lão phu / tại hạ / bổn tọa / tiền bối / vãn bối / đạo hữu / "
            "tiên trưởng / phu quân / phu nhân / sư phụ / sư huynh / sư muội / thúc thúc / "
            "tứ thúc / tiểu điệt / đại ca / tiểu đệ. Use \"ta\" for the first person, never "
            "\"tôi\". These carry the xianxia flavour and stay."
        ),
        "atmosphere_rule": (
            "Preserve the narrative voice — internal monologue, reflection, and its "
            "occasionally melancholic tone must carry through. The xianxia atmosphere should "
            "come from the honorifics of rule 5, the cultivation terms of rule 4, and the "
            "imagery itself — NOT from Hán-Việt-ising ordinary description. Avoid modern "
            "slang, but plain everyday Vietnamese words are always correct and always "
            "preferred over an obscure Sino-Vietnamese compound."
        ),
    },
    "fantasy": {
        "genre_line": (
            "Chinese web novels set in a WESTERN-style fantasy world of magic, knights and "
            "noble houses (not xianxia — there is no cultivation, no immortal sects)"
        ),
        "term_rule": (
            "Use the established Vietnamese terms for Western-fantasy concepts: ma pháp "
            "(magic), ma pháp sư (mage), đấu khí (battle aura), kỵ sĩ (knight), chiến sĩ, "
            "kiếm sĩ, cung thủ, lính đánh thuê (mercenary), pháp sư, tế tư (priest), thánh "
            "kỵ sĩ, ma thú, đế quốc, vương quốc, quý tộc, hoàng đế, thân vương. Noble ranks "
            "keep their standard Vietnamese forms: công tước (duke), hầu tước (marquis), bá "
            "tước (count), tử tước (viscount), nam tước (baron). "
            "Do NOT import xianxia vocabulary — there is no luyện khí, trúc cơ, kim đan, "
            "nguyên anh, linh khí or tu vi in this world."
        ),
        "honorific_rule": (
            "Forms of address suit a feudal European court, not a cultivation sect: ta / "
            "ngươi / hắn / nàng / ngài / đại nhân / các hạ / bệ hạ (Your Majesty) / điện hạ "
            "(Your Highness) / phu nhân / tiểu thư / lão gia / thiếu gia. Use \"ta\" for the "
            "first person, never \"tôi\". Do NOT use đạo hữu, tiền bối, sư huynh, sư muội or "
            "other sect honorifics — no such relationships exist here."
        ),
        "atmosphere_rule": (
            "Preserve the narrative voice — internal monologue, wry humour and reflection "
            "must carry through. The atmosphere is a Western fantasy epic: courts, magic "
            "academies, mercenaries and war. It should come from the imagery and the "
            "honorifics of rule 5, NOT from Hán-Việt-ising ordinary description. Avoid modern "
            "slang, but plain everyday Vietnamese words are always correct and always "
            "preferred over an obscure Sino-Vietnamese compound."
        ),
    },
}

QUOTE_RULES = {
    "curly": "curly double quotes “like this”",
    "straight": 'straight double quotes "like this"',
}
TITLE_CASE_RULES = {
    "title": "Capitalize each syllable of a proper-noun title.",
    "sentence": (
        "Capitalize the title like a sentence — first word only, plus genuine proper "
        "nouns. Write \"Chương 55: Trao đổi trận pháp\", not \"Trao Đổi Trận Pháp\"."
    ),
}


def build_system_prompt(
    glossary: dict[str, str],
    max_terms: int,
    style: str = "",
    quote_style: str = "curly",
    title_case: str = "title",
    genre: str = "xianxia",
) -> str:
    g = GENRES[genre]
    prompt = (
        SYSTEM_PROMPT.replace("{QUOTE_RULE}", QUOTE_RULES[quote_style])
        .replace("{TITLE_CASE_RULE}", TITLE_CASE_RULES[title_case])
        .replace("{GENRE_LINE}", g["genre_line"])
        .replace("{TERM_RULE}", g["term_rule"])
        .replace("{HONORIFIC_RULE}", g["honorific_rule"])
        .replace("{ATMOSPHERE_RULE}", g["atmosphere_rule"])
    )
    if glossary:
        terms = list(glossary.items())[:max_terms]
        lines = "\n".join(f"{cn} → {vi}" for cn, vi in terms)
        prompt += (
            "\n\nREQUIRED GLOSSARY — use exactly these Vietnamese renderings, never a variant:\n"
            f"{lines}"
        )
    return prompt + style


def split_paragraph(para: str, limit: int) -> list[str]:
    """Break one oversized paragraph on sentence punctuation."""
    parts = [p for p in SENTENCE_END_RE.split(para) if p]
    out: list[str] = []
    buf = ""
    for part in parts:
        if buf and len(buf) + len(part) > limit:
            out.append(buf)
            buf = part
        else:
            buf += part
    if buf:
        out.append(buf)
    # A single sentence longer than the limit: hard-split as a last resort.
    final: list[str] = []
    for p in out:
        while len(p) > limit * 2:
            final.append(p[: limit * 2])
            p = p[limit * 2 :]
        final.append(p)
    return final


def chunk_text(text: str, limit: int) -> list[str]:
    """Group paragraphs into chunks of roughly `limit` characters."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    buf: list[str] = []
    size = 0
    for para in paragraphs:
        pieces = [para] if len(para) <= limit else split_paragraph(para, limit)
        for piece in pieces:
            if buf and size + len(piece) > limit:
                chunks.append("\n\n".join(buf))
                buf, size = [], 0
            buf.append(piece)
            size += len(piece)
    if buf:
        chunks.append("\n\n".join(buf))
    return chunks


async def translate_chunk(
    client: AsyncOpenAI,
    system_prompt: str,
    model: str,
    temperature: float,
    chapter_title: str,
    chunk: str,
    retries: int,
    max_output: int,
    usage: Usage,
    min_expansion: float = MIN_EXPANSION,
    min_para_fraction: float = MIN_PARA_FRACTION,
    no_thinking: bool = True,
) -> str:
    user = (
        f"[Chapter: {chapter_title}]\n\n"
        "Translate the following chapter from Chinese to Vietnamese, following all "
        "the rules above. Output the heading exactly once, as the first line, then "
        "the body. Use one consistent spelling for every name throughout, and one "
        "consistent punctuation style for dialogue.\n\n"
        f"{chunk}"
    )
    delay = 2.0
    for attempt in range(1, retries + 1):
        try:
            resp = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user},
                ],
                temperature=temperature,
                max_tokens=max_output,
                # deepseek-v4-flash is a REASONING model: left to itself it spends
                # the whole output budget on hidden chain-of-thought and returns
                # finish_reason='length' with an EMPTY message. Measured on this
                # book: 29,999 completion tokens, all reasoning, 0 characters of
                # translation, 294 seconds — then a retry does it again.
                # `reasoning_effort` is silently ignored by this endpoint; only
                # disabling thinking works. Translation needs no deliberation, so
                # this is also ~2x faster and ~2x cheaper.
                extra_body={"thinking": {"type": "disabled"}} if no_thinking else None,
            )
            choice = resp.choices[0]
            out = (choice.message.content or "").strip()
            if not out:
                raise RuntimeError("empty response")
            # Now that a whole chapter goes in one request, hitting the output
            # ceiling would silently drop the end of the chapter. Treat it as a
            # failure so the retry loop re-requests it.
            if getattr(choice, "finish_reason", None) == "length":
                raise RuntimeError(
                    f"response hit the {max_output}-token ceiling and was truncated "
                    "— raise --max-output-tokens or lower --chunk-chars"
                )
            # The model occasionally echoes the Chinese source instead of
            # translating it. That used to pass the non-empty check and get
            # written straight to disk, leaving untranslated paragraphs
            # mid-chapter. A real translation is ~0% CJK.
            cjk_frac = len(CJK_RE.findall(out)) / len(out)
            if cjk_frac > ECHO_CJK_THRESHOLD:
                raise RuntimeError(
                    f"response is {cjk_frac:.0%} Chinese — model echoed the source "
                    "instead of translating"
                )
            # Partial echoes hide from the whole-response check: one echoed
            # paragraph inside a large chunk lands near 3% CJK. Sometimes the
            # model even emits the source paragraph AND its translation as two
            # paragraphs. Check each paragraph on its own so those are caught.
            for para in re.split(r"\n\s*\n", out):
                para = para.strip()
                if len(para) >= ECHO_MIN_PARA_CHARS:
                    frac = len(CJK_RE.findall(para)) / len(para)
                    if frac > ECHO_PARA_CJK_THRESHOLD:
                        raise RuntimeError(
                            f"a {len(para)}-char paragraph came back {frac:.0%} Chinese "
                            "— partial echo"
                        )
            hybrid = HYBRID_WORD_RE.search(out)
            if hybrid:
                raise RuntimeError(
                    f"a hanzi is fused into a Vietnamese word ({hybrid.group(0)!r}) "
                    "— corrupted word, not a translation"
                )
            # Silent early stop: no finish_reason, just a short body.
            expansion = len(out) / max(len(chunk), 1)
            if len(chunk) >= EXPANSION_MIN_SOURCE_CHARS and expansion < min_expansion:
                raise RuntimeError(
                    f"output is only {expansion:.2f}x the source ({len(out):,} vs "
                    f"{len(chunk):,} chars; expected ~3.3x) — content was dropped"
                )
            in_paras = len([p for p in re.split(r"\n\s*\n", chunk) if p.strip()])
            out_paras = len([p for p in re.split(r"\n\s*\n", out) if p.strip()])
            if in_paras >= 10 and out_paras < in_paras * min_para_fraction:
                raise RuntimeError(
                    f"paragraphs collapsed {in_paras} -> {out_paras} — source structure "
                    "lost, which breaks reader layout and TTS chunking"
                )
            usage.add(getattr(resp, "usage", None))
            return out
        except Exception as e:  # noqa: BLE001 — retry anything transient
            if attempt == retries:
                raise
            logger.warning(f"  attempt {attempt}/{retries} failed ({e}); retrying in {delay:.0f}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)
    raise RuntimeError("unreachable")


async def translate_file(
    client: AsyncOpenAI,
    system_prompt: str,
    args: argparse.Namespace,
    src: Path,
    dst: Path,
    usage: Usage,
) -> tuple[str, int]:
    text = src.read_text(encoding="utf-8").strip()
    if not text:
        return "empty", 0

    title = text.splitlines()[0].strip()
    chunks = chunk_text(text, args.chunk_chars)

    translated: list[str] = []
    for n, chunk in enumerate(chunks, start=1):
        piece = await translate_chunk(
            client,
            system_prompt,
            args.model,
            args.temperature,
            title,
            chunk,
            args.retries,
            args.max_output_tokens,
            usage,
            args.min_expansion,
            args.min_para_fraction,
            not args.thinking,
        )
        # A chapter over --chunk-chars still splits, and every chunk is its own
        # stateless call, so chunks 2+ tend to re-emit the heading. Drop it —
        # otherwise the file carries several differently-translated headings.
        if n > 1:
            lines = piece.splitlines()
            if lines and re.match(r"^\s*Chương\s+\d+\s*:", lines[0]):
                piece = "\n".join(lines[1:]).lstrip()
        translated.append(piece)
        if len(chunks) > 1:
            logger.info(f"  {src.name}: chunk {n}/{len(chunks)}")

    out = sanitize("\n\n".join(translated)) + "\n"

    leftover = len(CJK_RE.findall(out))
    if leftover:
        pct = leftover / max(len(out), 1) * 100
        logger.warning(
            f"  {src.name}: {leftover} Chinese char(s) left in the translation "
            f"({pct:.2f}%) — TTS will read these wrong, check the file"
        )

    dst.write_text(out, encoding="utf-8")
    return "ok", len(out)


async def run(args: argparse.Namespace) -> None:
    in_dir = Path(args.input)
    out_dir = Path(args.out)
    if not in_dir.is_dir():
        raise SystemExit(f"No such directory: {in_dir}")

    files = sorted(p for p in in_dir.glob("*.txt"))
    total_in_book = len(files)  # before --limit, so a test run can project the full cost
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

    # UTF-8 hanzi ≈ 3 bytes; a hanzi is ≈ 1 input token.
    per_file_chars = [f.stat().st_size // 3 for f in todo]
    src_chars = sum(per_file_chars)
    # Each chapter is split into chunks, and every chunk is its own request that
    # re-sends the whole system prompt — so requests, not chapters, drive input cost.
    n_requests = sum(max(1, -(-c // args.chunk_chars)) for c in per_file_chars)
    logger.info(
        f"{len(files)} chapter file(s); {skipped} already translated, {len(todo)} to do "
        f"(~{src_chars:,} source chars in ~{n_requests:,} request(s))"
    )

    # Validate style pairs before the dry-run exit — a typo here must not be
    # discovered only once --apply has started spending money.
    style_cn = args.style_cn or []
    style_vi = args.style_vi or []
    if len(style_cn) != len(style_vi):
        raise SystemExit("--style-cn and --style-vi must be given the same number of times")
    pairs = [(Path(c), Path(v)) for c, v in zip(style_cn, style_vi)]
    for c, v in pairs:
        if not c.is_file() or not v.is_file():
            raise SystemExit(f"Style example missing: {c if not c.is_file() else v}")
    style = build_style_block(pairs, args.style_paras)
    if pairs:
        logger.info(
            f"Using {len(pairs)} style example pair(s), {args.style_paras} paragraphs each "
            f"({len(style):,} chars of prompt prefix)"
        )

    # Loaded before the dry-run exit for the same reason as the style pairs: a
    # malformed glossary.json must not surface mid-run once money is being spent.
    glossary: dict[str, str] = {}
    if args.glossary:
        gpath = Path(args.glossary)
        if gpath.exists():
            try:
                glossary = json.loads(gpath.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                raise SystemExit(f"{gpath} is not valid JSON: {e}")
            logger.info(f"Loaded {len(glossary)} glossary term(s) from {gpath}")
        else:
            gpath.parent.mkdir(parents=True, exist_ok=True)
            gpath.write_text("{}\n", encoding="utf-8")
            logger.info(f"Created empty glossary at {gpath} — add terms to lock names down")

    system_prompt = build_system_prompt(
        glossary, args.max_glossary_terms, style, args.quote_style, args.title_case, args.genre
    )

    # The system prompt is byte-identical on every request, so after the first
    # call it bills at the cache-hit rate. The chapter text never repeats and is
    # always a cache miss — so the cache covers the prefix, not "80% of input".
    sys_tok = approx_tokens(system_prompt)
    cached_tok = sys_tok * max(n_requests - 1, 0)
    fresh_tok = sys_tok + src_chars  # first call's prompt + all chapter text
    out_tok = int(src_chars * args.out_ratio)
    cost = (
        (cached_tok / 1e6) * args.price_cached
        + (fresh_tok / 1e6) * args.price_in
        + (out_tok / 1e6) * args.price_out
    )
    logger.info(
        f"System prompt ≈ {sys_tok:,} tokens ({len(system_prompt):,} chars), resent on each "
        f"of ~{n_requests:,} requests"
    )
    logger.info(
        f"Rough estimate: ~{cached_tok:,} cached + ~{fresh_tok:,} fresh input, "
        f"~{out_tok:,} output tokens ≈ ${cost:.2f} "
        f"(${args.price_cached}/${args.price_in}/${args.price_out} per 1M). "
        f"Output assumed {args.out_ratio}x the source token count — the real driver; "
        "check it against the test run's actual usage before trusting the total"
    )

    if not args.apply:
        logger.info("DRY RUN — nothing sent, nothing written. Re-run with --apply.")
        logger.info("Tip: --limit 2 --apply first to eyeball the tone before the full run.")
        return

    if not todo:
        logger.info("Nothing to do.")
        return

    api_key = args.api_key or os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        try:
            from app.config import settings

            api_key = getattr(settings, "deepseek_api_key", None)
        except Exception:  # noqa: BLE001 — config needs Supabase vars we don't use here
            api_key = None
    if not api_key:
        raise SystemExit("Set DEEPSEEK_API_KEY in backend/.env (or pass --api-key)")

    out_dir.mkdir(parents=True, exist_ok=True)
    client = AsyncOpenAI(api_key=api_key, base_url=DEEPSEEK_BASE_URL, timeout=300.0)
    sem = asyncio.Semaphore(args.concurrency)
    usage = Usage()
    done = 0
    failed: list[str] = []

    async def worker(src: Path) -> None:
        nonlocal done
        async with sem:
            try:
                status, size = await translate_file(
                    client, system_prompt, args, src, out_dir / src.name, usage
                )
            except Exception as e:  # noqa: BLE001 — one bad chapter shouldn't kill the run
                failed.append(src.name)
                logger.error(f"FAILED {src.name}: {e}")
                return
        done += 1
        logger.info(f"[{done}/{len(todo)}] {src.name} → {size:,} chars ({status})")

    await asyncio.gather(*(worker(f) for f in todo))

    logger.info(f"Done: {done} translated, {len(failed)} failed, {skipped} skipped")

    if usage.calls:
        actual = usage.cost(args.price_cached, args.price_in, args.price_out)
        # Against SOURCE tokens only — dividing by total prompt tokens would fold
        # in the system prompt resent on every call and understate the ratio.
        ratio = usage.completion / max(src_chars, 1)
        logger.info(
            f"Billed: {usage.calls:,} call(s), {usage.cache_hit:,} cached + "
            f"{usage.cache_miss:,} fresh input, {usage.completion:,} output tokens "
            f"= ${actual:.4f}"
        )
        if done:
            logger.info(
                f"Per chapter: ${actual / done:.4f} → ~${actual / done * total_in_book:.2f} "
                f"for all {total_in_book} chapter(s) in {in_dir} (measured, not estimated). "
                "A warm prefix cache makes this optimistic on a short test run"
            )
        # Feed this back into --out-ratio so the pre-run estimate stops guessing.
        logger.info(f"Actual output/input token ratio: {ratio:.2f} (pass --out-ratio {ratio:.1f})")

    if failed:
        logger.warning(f"Re-run the same command to retry the {len(failed)} failure(s): {failed[:10]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", help="directory of Chinese chapter .txt files")
    ap.add_argument("-o", "--out", required=True, help="directory for Vietnamese output")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"default: {DEFAULT_MODEL}")
    ap.add_argument(
        "--temperature",
        type=float,
        default=0.3,
        help="low = faithful and consistent across chapters (default: 0.3). "
        "DeepSeek's docs suggest 1.3 for translation, which reads more fluently "
        "but drifts on proper nouns over a long book",
    )
    ap.add_argument("--concurrency", type=int, default=4, help="parallel chapters (default: 4)")
    ap.add_argument("--chunk-chars", type=int, default=CHUNK_CHARS, help=f"default: {CHUNK_CHARS}")
    ap.add_argument("--retries", type=int, default=5, help="attempts per chunk (default: 5)")
    ap.add_argument(
        "--max-output-tokens",
        type=int,
        default=MAX_OUTPUT_TOKENS,
        help=f"raise if the model allows longer replies (default: {MAX_OUTPUT_TOKENS})",
    )
    ap.add_argument(
        "--min-expansion",
        type=float,
        default=MIN_EXPANSION,
        help="reject a reply shorter than this multiple of the source — catches the "
        f"model stopping early without setting finish_reason (default: {MIN_EXPANSION}). "
        f"Ignored for sources under {EXPANSION_MIN_SOURCE_CHARS} chars, which are author's "
        "notes and winner lists that legitimately do not expand",
    )
    ap.add_argument(
        "--min-para-fraction",
        type=float,
        default=MIN_PARA_FRACTION,
        help="reject a reply whose paragraph count falls below this fraction of the "
        f"source's (default: {MIN_PARA_FRACTION}). Lower it for chapters built from very "
        "short staccato lines, where the model cannot hold the structure in one pass",
    )
    ap.add_argument(
        "--genre",
        choices=sorted(GENRES),
        default="xianxia",
        help="terminology, honorifics and atmosphere set. Use 'fantasy' for Western-style "
        "magic/knight/noble settings — a xianxia prompt would inject luyện khí and address "
        "knights as đạo hữu (default: xianxia)",
    )
    ap.add_argument(
        "--quote-style",
        choices=sorted(QUOTE_RULES),
        default="curly",
        help="dialogue quote marks. Match whatever the already-translated chapters "
        "of this book use, or chapter 61 will look unlike chapter 60 (default: curly)",
    )
    ap.add_argument(
        "--title-case",
        choices=sorted(TITLE_CASE_RULES),
        default="title",
        help="chapter-heading capitalisation: 'title' (Trao Đổi Trận Pháp) or "
        "'sentence' (Trao đổi trận pháp). Match the existing chapters (default: title)",
    )
    ap.add_argument(
        "--thinking",
        action="store_true",
        help="let the model use chain-of-thought. OFF by default: deepseek-v4-flash "
        "otherwise spends the entire output budget reasoning and returns an EMPTY "
        "translation (measured: 29,999 reasoning tokens, 0 characters, 294s). "
        "Translation needs no deliberation, and disabling it is ~2x faster and cheaper",
    )
    ap.add_argument("--limit", type=int, help="only process the first N chapters (test runs)")
    ap.add_argument("--force", action="store_true", help="re-translate chapters already done")
    ap.add_argument("--glossary", help="path to glossary.json ({\"斗气\": \"đấu khí\"})")
    ap.add_argument("--max-glossary-terms", type=int, default=500, help="default: 500")
    ap.add_argument(
        "--style-cn",
        action="append",
        help="Chinese chapter file to use as a style example (repeatable; pair with --style-vi)",
    )
    ap.add_argument(
        "--style-vi",
        action="append",
        help="approved Vietnamese translation matching the same --style-cn position",
    )
    ap.add_argument(
        "--style-paras",
        type=int,
        default=8,
        help="paragraphs taken from each style example (default: 8)",
    )
    ap.add_argument("--api-key", help="override DEEPSEEK_API_KEY")
    # deepseek-v4-flash rates; override for a different model or after a price change.
    ap.add_argument("--price-in", type=float, default=0.14, help="USD per 1M cache-MISS input")
    ap.add_argument("--price-cached", type=float, default=0.0028, help="USD per 1M cache-HIT input")
    ap.add_argument("--price-out", type=float, default=0.28, help="USD per 1M output tokens")
    ap.add_argument(
        "--out-ratio",
        type=float,
        default=2.5,
        help="Vietnamese output tokens per source token. Measured 2.2-3.0 on real "
        "deepseek-v4-flash runs of this pipeline — one hanzi becomes several "
        "Vietnamese syllables, so 1.0 badly underestimates (default: 2.5)",
    )
    ap.add_argument("--apply", action="store_true", help="actually call the API (default: dry run)")
    args = ap.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
