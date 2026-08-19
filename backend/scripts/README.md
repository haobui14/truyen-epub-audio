# `backend/scripts/` — CLI tools

Two unrelated families of scripts live here:

| Family | What it touches | Scripts |
|---|---|---|
| **Translation pipeline** | Local files only (`backend/work/…`). Never touches the database. | `clean_source_txt`, `split_book_chapters`, `glossary_from_markdown`, `build_glossary_deepseek`, `translate_chapters_*`, `audit_translation`, `sanitize_translation`, `merge_chapters` |
| **Production maintenance** | Live Supabase DB + Storage. | `export_book_txt`, `strip_string_from_book`, `remove_spam_paragraphs`, `compress_chapter_text`, `migrate_chapter_text_to_storage`, `cleanup_storage` |

The translation pipeline turns a raw Chinese novel `.txt` into a Vietnamese
`.txt`/EPUB you upload through the normal admin UI. It is completely offline —
if a translation run goes wrong, nothing in production is affected.

---

## Conventions shared by every script

**Run them as modules, from `backend/`** — not as file paths. Each one does
`sys.path.insert(0, backend/)` so `app.*` imports resolve:

```bash
cd backend && python -m scripts.split_book_chapters book.txt -o work/x/cn
```

**Dry run is the default.** Every script that writes files, rewrites storage, or
spends money reports what it *would* do and exits. `--apply` is what actually
commits. Read the dry-run summary before applying — this is not ceremony, it has
caught real damage (see [Lessons](#lessons-learned-the-hard-way)).

**stdout is forced to UTF-8.** The Windows console defaults to a legacy codepage
and would print Chinese headings and Vietnamese diacritics as `\uXXXX` escapes,
which defeats the point of reviewing a dry run.

**Resumability.** Long runs are interruptible. Translators skip any chapter whose
output file already exists and is non-empty; storage scripts are idempotent
(`compress_chapter_text` skips already-gzipped objects, `strip_string_from_book`
has an explicit `--state` resume file).

---

## The translation pipeline

```
raw .txt  ─► clean_source_txt  ─►  split_book_chapters  ─►  cn/0001_….txt
                                                              │
                     glossary.json ◄── glossary_from_markdown ─┤
                          │            build_glossary_deepseek ┘
                          ▼
                  translate_chapters_*  ─►  vi/0001_….txt
                                                │
                          audit_translation ◄───┤   (report only)
                        sanitize_translation ◄──┤   (rewrites in place)
                                                ▼
                            merge_chapters  ─►  Book_vi.txt
                                                ▼
                                      upload via admin UI
```

Working layout, one directory per book (e.g. `backend/work/emo/`):

```
work/emo/
  _raw.txt        original download
  clean.txt       after clean_source_txt
  cn/             per-chapter Chinese, 0001_第一章….txt
  vi/             per-chapter Vietnamese, same filenames
  glossary.json   {"斗气": "đấu khí", …}
  Ac_Ma_Phap_Tac_vi.txt / .epub
```

---

### 1. `clean_source_txt.py` — strip pirate-site boilerplate

Books scraped from sites like QiSuWang wrap every chapter in junk, so a naive
split produces hundreds of near-empty chapters. One chapter arrives as:

```
------------            separator rule
第一章 【白痴】          title, spaced
恶魔法则                book title
（收藏，砸票！）          author's plea for votes
第一章【白痴】           the SAME title again, unspaced
<the actual chapter>
```

The heading appears twice, so the splitter opens a chapter on the first one,
finds only boilerplate before the second, and emits an empty file. On 恶魔法则
that was 337 chapters under 200 characters.

What it fixes:

- **Duplicate headings** — collapses runs of headings sharing a chapter *number*.
  The number is the reliable signal; the two title lines are often not textually
  identical (`第九章【若琳的计划】` vs `第九章【若琳的色诱计划】`). It works on
  heading→body blocks rather than adjacency, because an author's aside usually
  sits between the twins. It checks both the next *and* the previous heading —
  looking only forward left every trailing repeat behind as an empty chapter.
- **Glued headings** — `恶魔法则第八十三章【…】,,身为一名魔法师…` welded onto the
  first paragraph. 101 lines looked like this; each one cost a chapter.
- **Boilerplate lines, horizontal rules, HTML entities, repeated title lines.**

```bash
python -m scripts.clean_source_txt work/emo/_raw.txt -o work/emo/clean.txt --book-title 恶魔法则 --apply
```

> ⚠️ **A chapter heading is never boilerplate.** An early version filtered short
> lines matching `推荐票|月票|砸票` and **deleted 156 whole chapters**, because
> this author appends vote pleas to the heading itself. The heading vanished and
> its body was absorbed into the previous chapter. The code now checks
> `heading_number(line) is None` *before* the boilerplate test. Always verify a
> clean pass with a chapter-number gap check against the raw file.

> **Known limitation, deliberately left alone:** headings the scraper broke across
> lines mid-bracket (`第两百三十七章 【双赢` / `】（双倍月票…）`) keep a stub
> heading. An attempt to rejoin them swallowed real paragraphs — coverage fell
> 667→661 chapters and 69,000 characters of body text vanished. A visible stub is
> harmless; losing text is not. Fix those by hand if it matters.

---

### 2. `split_book_chapters.py` — one file per chapter

Detects `第一章` / `第1章` / `第三回` / `楔子` / `序章` at the start of a short
line and writes `0001_<heading>.txt`, `0002_…`, plus a `manifest.json`.

The zero-padded index prefix is load-bearing: it makes a plain filename sort equal
chapter order, which is what `merge_chapters` relies on later.

Encoding is autodetected across `utf-8-sig, utf-8, gb18030, big5, utf-16`. Order
matters — `gb18030` decodes almost any byte stream, so strict UTF-8 is tried
first. Fullwidth indent characters (`　`, `\xa0`) are stripped so the translator
doesn't pay tokens for them and TTS never reads them.

| Flag | Meaning |
|---|---|
| `--encoding` | force one instead of autodetecting |
| `--max-heading-len` | a line longer than this is never a heading (default 40) |
| `--loose` | also accept bare numbered lines (`123 标题`) |
| `--apply` | write files |

```bash
python -m scripts.split_book_chapters work/emo/clean.txt -o work/emo/cn --apply
```

Volume markers (`第一卷`) are reported but not treated as chapters.

---

### 3. Building the glossary

The glossary is the single source of truth for how every proper noun is spelled.
It is passed to the translator on every chapter, so chapter 700 spells a name the
same way chapter 1 did. Format is a flat map:

```json
{"杜维": "Đỗ Duy", "魔法师": "ma pháp sư", "斗气": "đấu khí"}
```

**`glossary_from_markdown.py`** — convert a hand-written markdown table (column 1
Chinese, column 3 Vietnamese) into `glossary.json`. Keep the markdown as the
source of truth and re-run after editing it. If a cell reads `Linh Mễ / Gạo Linh`
it takes the first form — the whole point of a glossary is one term, one
rendering. Conflicting duplicate rows are reported; the first spelling wins.

```bash
python -m scripts.glossary_from_markdown work/x/glossary_source.md -o work/x/glossary.json
```

**`build_glossary_deepseek.py`** — for a book that already has approved
translations. Pairs each file in `vi_ref/` with the same-named file in `cn/`, asks
DeepSeek to extract the proper nouns it sees in both, and merges the results. Use
this when continuing a book someone else started, so new chapters match the names
readers have already seen.

```bash
python -m scripts.build_glossary_deepseek work/x/cn work/x/vi_ref -o work/x/glossary.json --apply
```

> Keep glossary keys at two characters or more. A single-hanzi key matches inside
> unrelated compounds and corrupts them.

---

### 4. The translators

Four backends, **one identical contract**: same input dir, same output dir, same
`--glossary` / `--style-cn` / `--style-vi` flags, same resume behaviour. Swap them
freely mid-book — that is exactly what happened on 恶魔法则 when DeepSeek ran out
of credit at chapter 390 and Sonnet finished the rest.

`translate_chapters_deepseek.py` is the **canonical** one. The other three import
`build_system_prompt`, `GENRES`, `QUOTE_RULES`, `TITLE_CASE_RULES`, `chunk_text`
and the quality guards from it, so all four share one prompt. **Edit the prompt in
the DeepSeek module only.**

| Script | Auth / billing | Concurrency | Use when |
|---|---|---|---|
| `translate_chapters_deepseek.py` | `DEEPSEEK_API_KEY` in `backend/.env` | 4 | Default. Cheapest per chapter. |
| `translate_chapters_claude_cli.py` | Claude Code OAuth (`~/.claude/`) — **subscription, not API billing** | 3 | DeepSeek out of credit, or you want Sonnet quality. |
| `translate_chapters_codex_cli.py` | `codex login` | 2 | Third fallback. |
| `translate_chapters_claude.py` | `ANTHROPIC_API_KEY` | 4 (live) | `--batch` uses the Messages Batches API: half price, results within ~1h. |

#### The prompt

Instructions are in **English on purpose** — the model follows English directives
more precisely while still producing native Vietnamese. The system prompt is kept
byte-identical across every request so DeepSeek's automatic prefix cache hits on
all but the first call (cache-hit input is $0.0028 vs $0.14 per 1M — a 50×
discount on the largest part of each request).

Eleven numbered rules. The two that matter most:

- **Rule 2 — write ordinary Vietnamese, not Hán-Việt transliteration.** Hán-Việt
  is allowed in exactly two places: proper nouns (rule 3) and the fixed
  genre-terminology list (rule 4). Everything else is plain modern Vietnamese,
  with worked NOT-this/THIS examples (`天光` → "ánh sáng trời", *not* "thiên
  quang"). The test given to the model: *would a Vietnamese reader who knows no
  Chinese understand this immediately?*
- **Rule 10 — the chapter heading must be translated,** rendered as
  `Chương <n>: <title>`, with examples separating proper-noun titles
  (transliterate) from ordinary-word titles (translate).

#### `--genre` — pick the right terminology set

```bash
--genre xianxia   # default: luyện khí, kim đan, đạo hữu, sư huynh
--genre fantasy   # ma pháp sư, kỵ sĩ, bệ hạ, công tước
```

Getting this wrong is very visible. 恶魔法则 is Western fantasy (魔法 appears
8,778 times vs 修炼 228); the xianxia prompt would inject cultivation stages and
address knights as *đạo hữu*. Check that ratio before starting a book.

`--quote-style curly|straight` and `--title-case title|sentence` exist for the
same reason: when continuing a partly-translated book, match what chapters 1–60
already use, or chapter 61 looks like a different book.

#### Whole-chapter translation

`CHUNK_CHARS = 12000` — effectively one API call per chapter.

Splitting a chapter across several independent calls was **the single worst
quality bug in this pipeline**. Each call saw only its own fragment, so it
re-emitted the chapter heading (one chapter came back with four differently
translated headings), re-invented character names between fragments (three
spellings of one name), and switched dialogue punctuation halfway through.
Nothing downstream can repair that — the fragments simply never agreed with each
other.

`deepseek-v4-flash` accepts `max_tokens` up to 128k (probed), and the longest
chapter here is ~11.1k hanzi, so one call always fits. Fewer, larger requests are
also cheaper: the system prompt is resent 1.3k times instead of 4.7k.

#### `--thinking` is OFF by default — and must stay off

`deepseek-v4-flash` is a reasoning model. Left alone it spends the **entire**
output budget on hidden chain-of-thought and returns nothing:

```
completion_tokens = 29,999   reasoning_tokens = 29,999   content = ""   time = 294s
```

It surfaces as `finish_reason=length` with an empty message, and the retry does
exactly the same thing. `reasoning_effort=minimal|low` is silently **ignored** by
this endpoint. The only thing that works is
`extra_body={"thinking": {"type": "disabled"}}`, which the script now sends by
default. Translation needs no deliberation, and disabling it roughly halves both
time and cost.

#### Quality guards (applied on every write)

A chapter failing any of these is retried, and the failure is logged rather than
silently written:

| Guard | Constant | Catches |
|---|---|---|
| Whole-response echo | `ECHO_CJK_THRESHOLD = 0.10` | model handed back the Chinese source |
| Per-paragraph echo | `ECHO_PARA_CJK_THRESHOLD = 0.30`, min 25 chars | partial echo inside one paragraph |
| Fused hybrid word | `HYBRID_WORD_RE` | a hanzi welded into a Vietnamese word (`ngọc ph符`) — too small for the paragraph guard to notice, and it corrupts the word itself |
| Truncation | `MIN_EXPANSION = 1.8` | model stopped early *without* setting `finish_reason`. CN→VI runs ~3.3× in characters, so anything under 1.8× lost content. Skipped for sources under 1,200 chars — author's notes and winner lists legitimately don't expand |
| Paragraph collapse | `MIN_PARA_FRACTION = 0.60` | model fused many short paragraphs into few huge ones (one chapter went 233 → 7 while keeping a normal character count), destroying the blank-line boundaries the reader renders and the TTS chunker splits on |

`sanitize()` additionally strips markdown emphasis and CJK brackets on every
write — rule 8b asks the model not to emit them, but over thousands of calls it
slips, so it is enforced deterministically too.

#### CLI-translator specifics

`translate_chapters_claude_cli.py` drives the bundled Claude Code CLI through
`claude-agent-sdk`. Notable hardening:

- **`ANTHROPIC_API_KEY` is unset for the run** so a stray key can't silently
  switch you from subscription to API billing (`--use-api-key` keeps it).
- `tools=[]` — pure text generation. A tool call would mean the model went
  looking at the filesystem instead of translating.
- `max_turns=1` — it answers once and stops, never continuing agentically.
- `setting_sources=None` — no `CLAUDE.md` or project memory can leak into a
  translation prompt.
- Rate-limit rejections stop the run cleanly instead of burning every retry.

`translate_chapters_codex_cli.py` runs each chapter in a separate ephemeral
`codex exec` process: `--sandbox read-only`, `--ask-for-approval never`,
`--ignore-rules`, `--ignore-user-config` — the same isolation goal, so unrelated
coding instructions never leak into a translation.

```bash
python -m scripts.translate_chapters_deepseek work/emo/cn -o work/emo/vi --glossary work/emo/glossary.json --genre fantasy
```

```bash
python -m scripts.translate_chapters_deepseek work/emo/cn -o work/emo/vi --glossary work/emo/glossary.json --genre fantasy --limit 2 --apply
```

```bash
python -m scripts.translate_chapters_deepseek work/emo/cn -o work/emo/vi --glossary work/emo/glossary.json --genre fantasy --apply
```

Same book, Sonnet via subscription (DeepSeek out of credit) — resumes where it
stopped:

```bash
python -m scripts.translate_chapters_claude_cli work/emo/cn -o work/emo/vi --glossary work/emo/glossary.json --genre fantasy --model sonnet --concurrency 3 --apply
```

> **Resume trap:** a re-run skips any output file that exists and is non-empty. If
> a `--force` pass was interrupted partway, the not-yet-redone chapters still hold
> the *old* output and a plain resume will skip them forever. Delete the affected
> files first.

> **Background runs die with the session.** Twice a parent process was killed and
> left ~16 idle `claude.exe` children, so the process list looked busy while
> nothing was being written. Diagnose by watching the output file count for ~70s:
> flat means dead, not slow. Do **not** blanket-kill `claude.exe` on Windows — an
> interactive Claude Code session is indistinguishable from the orphans.

---

### 5. `audit_translation.py` — report card, changes nothing

Compares `vi/` against `cn/` and reports four failure modes:

1. **Truncation** — VI/CN character ratio far below the corpus median
   (`--ratio-floor-frac`, default 0.7).
2. **Lost structure** — VI paragraph count differing from the Chinese by more
   than `--para-tolerance` (default 2).
3. **Untranslated** — leftover hanzi. TTS reads these wrong.
4. **Name drift** — the same proper noun spelled two ways across chapters.

Drift is the one you cannot eyeball: a name can be perfectly consistent for 200
chapters and slip afterwards. Candidates are clustered by their diacritic-stripped
form, so spellings differing only in tone marks (`Triêu Vân` / `Triều Vân`) land
in the same bucket, with the glossary's spelling marked as correct where the
glossary covers it. A stopword list plus a sentence-start check removes most false
positives.

```bash
python -m scripts.audit_translation work/emo/cn work/emo/vi --glossary work/emo/glossary.json -o work/emo/audit.json
```

---

### 6. `sanitize_translation.py` — deterministic cleanup, three passes

1. **Markup** — markdown emphasis, CJK brackets, decorative punctuation runs,
   invisible/zero-width characters. The reader shows these literally and edge-tts
   pronounces them.
2. **Name drift** — folds variant spellings onto the glossary spelling.
3. **Report** — files still containing hanzi. Those need *re-translating*, not
   repairing, so they are only listed — or deleted with `--delete-cjk` so the
   translate step regenerates them.

Pass 2 is deliberately conservative. Two distinct Chinese names can collapse to
one key once diacritics are stripped — 萧元思 → "Nguyên Tư" and 李渊修 → "Nguyên
Tu" are different characters, not a typo — so a variant is rewritten **only** when
the glossary names the correct spelling. Everything else is reported for review.

| Flag | Meaning |
|---|---|
| `--glossary` | authority for name spelling |
| `--normalize-quotes straight\|curly` | force one dialogue style across the book; the model mixes marks within a chapter regardless of the prompt |
| `--delete-cjk` | delete files still containing hanzi so the translator regenerates them |
| `--min-age N` | skip files modified in the last N seconds — makes it safe to run while a translation is still going |
| `--apply` | write changes |

```bash
python -m scripts.sanitize_translation work/emo/vi --glossary work/emo/glossary.json --normalize-quotes curly --apply
```

Idempotent — a cleaned file produces no further changes on re-run.

> `DECOR_RUN_RE` deliberately excludes `.` and `,`. An earlier version collapsed
> `...` and would have mangled dialogue across 570 files ("Hình như. ta tạch
> rồi?"). Runaway dot runs of four or more are normalised back to a three-dot
> ellipsis instead.

---

### 7. `merge_chapters.py` — back into one book

Concatenates `vi/*.txt` in filename order into a single UTF-8 file, one blank line
between chapters, each chapter keeping its heading as the first line.

Filename order *is* chapter order thanks to the zero-padded prefix. Gaps are
expected once unwanted chapters have been deleted, so they are **reported** rather
than treated as an error — a missing chapter can't slip by unnoticed. It refuses
to overwrite an existing output without `--force`, and never reads its own output
back in as a chapter.

```bash
python -m scripts.merge_chapters work/emo/vi -o work/emo/Ac_Ma_Phap_Tac_vi.txt
```

Then upload the `.txt` through the admin UI like any other book.

---

## Production maintenance

These talk to the live database and Storage. They read Supabase credentials from
`backend/.env` via `app.database` / `app.services.storage_service`.

Chapter text lives in the private `chapter-text` bucket at
`{book_id}/{chapter_id}.txt`, **gzip-compressed**, with
`Content-Type: application/gzip` and never `Content-Encoding` (storage3/httpx
would auto-decompress the latter and break app-level gunzip). All reads and writes
funnel through `storage_service.download_chapter_text` / `upload_chapter_text`.

### `export_book_txt.py`

Export one book's chapters to a single `.txt`, in `chapter_index` order — the
mirror of the `/api/books/{id}/epub` export. Reads are version-keyed with each
row's `updated_at`, so the CDN can't hand back pre-edit text.

```bash
python -m scripts.export_book_txt <book_id> -o C:\some\dir
```

### `strip_string_from_book.py`

Remove a literal string or regex match from chapter text, for one book or all.
Terminal twin of `POST /api/books/{id}/strip-string`, sharing its logic via
`app.services.text_cleanup` so an admin-UI preview and a run here agree.

Use this rather than the admin UI for big jobs: the endpoint holds one HTTP request
open for the whole pass, and the library is ~114k chapters — hours of Storage
round-trips, well past any gateway timeout.

Site watermarks are machine-translated **per chapter**, so one exact string
typically matches a tiny fraction of its own occurrences (one book carried 137
variants of a single promo line). Prefer `--regex --whole-line`, and always read
the dry-run sample before adding `--apply`.

Preview across every book, writing the hit list to a manifest:

```bash
python -m scripts.strip_string_from_book all "dtv[\s\-_]*ebook" --regex --whole-line --manifest dtv.json
```

Apply, touching only the chapters the preview found (much faster):

```bash
python -m scripts.strip_string_from_book all "dtv[\s\-_]*ebook" --regex --whole-line --manifest dtv.json --state dtv.done --apply
```

`--state` appends each chapter id as it lands and skips those ids on a re-run, so
a killed run resumes instead of restarting.

### `remove_spam_paragraphs.py`

Purpose-built for truyen.thichcode.net watermarks, which are obfuscated with
random punctuation and spacing so naive matching misses them:

```
t-r,uy en .t h i chco de,.net
tr uyện được c.o-p y tạ,i- .tr,u.ye,n-.t,hi.c h,cod e . net
```

Instead of a regex arms race, it **normalizes** each paragraph (strip Vietnamese
diacritics, fold `đ`→`d`, lowercase, drop everything that isn't `a-z0-9`) and
looks for the signature token `thichcode`. Every obfuscation variant collapses to
it. Also refreshes `chapters.word_count` for modified chapters so the UI stays
consistent.

```bash
python -m scripts.remove_spam_paragraphs --book-id <id>
```

```bash
python -m scripts.remove_spam_paragraphs --apply --workers 8
```

`--signature anothersite` adds another token for a different pirate site.

### `compress_chapter_text.py`

One-shot migration that gzips the ~87k legacy plain-UTF-8 objects in place.
Measured 916 MB → ~320 MB. Same object path, so no DB change; idempotent and
resumable.

> ⚠️ **Deploy the gzip-aware `storage_service.py` before running `--apply`.** The
> old backend would `.decode('utf-8')` gzip bytes and serve empty chapters.

Downloads go over an HTTP/1.1 client rather than storage3's shared HTTP/2
connection — storage3 multiplexes all concurrent downloads onto one connection,
and under 8-way fan-out Supabase drops the stream, tripping storage3's
`UnboundLocalError: ... 'response'` bug on nearly every request.

### `migrate_chapter_text_to_storage.py`

Historical one-shot: moved `chapters.text_content` out of Postgres into Storage.
Uses a thread pool, since storage3 and supabase-py are sync and `asyncio.gather`
over them gives no real parallelism. Already run; kept for reference. Its docstring
lists the follow-up SQL (`ALTER TABLE chapters DROP COLUMN text_content;` etc).

### `cleanup_storage.py`

Two independent jobs:

1. **chapter-text orphans** — delete objects whose `chapter_id` no longer exists
   in the `chapters` table. These accumulate because book deletes, reparses, and
   auto-splits clean storage on a best-effort basis; one failed delete leaves the
   `.txt` behind forever.
2. **epub-uploads** — wipe the bucket of original uploaded files.
   ⚠️ After this the admin **"Phân tích lại"** (reparse) button stops working,
   since it re-parses from these stored originals.

```bash
python -m scripts.cleanup_storage --only chapter-text --apply
```

---

## Lessons learned the hard way

Every item here is a bug that actually shipped, plus the guard now in the code.

**Structural metrics measure fidelity, not readability.** Expansion ratio,
paragraph alignment and leftover-hanzi counts all passed cleanly while the
translation was unreadable Hán-Việt soup. Both quality problems that mattered were
caught by a human reading the output, not by any metric. Have someone read actual
chapters before declaring a book done.

**A chapter heading is never boilerplate.** Cost: 156 deleted chapters.

**Never chunk a chapter across independent calls.** Cost: 772 of 891 chapters with
inconsistent names, headings and punctuation.

**Reasoning models silently eat the output budget.** Cost: hours of runtime
producing empty files that looked like ordinary API flakiness.

**`\s` matches newlines.** A `re.sub(r'\s{2,}', ' ', …)` intended to fix four
characters collapsed 74 paragraphs into one. Use `[ \t]` when you mean spaces.

**Don't collapse `.` runs.** `...` is legitimate ellipsis and appears constantly in
this genre.

**A glossary is not a capitalisation authority.** Title-casing every glossary term
across the corpus over-capitalised 2,016 ordinary words in 330 files. The sanitizer
now detects terms that appear mostly lowercase in the corpus and skips folding
them.

**Take the largest number on a heading line.** A parser matching the first `第X章`
grabbed `第二章` out of an author's aside and numbered chapter 458 as chapter 2.

**Back up before `--apply` on already-approved output.** Dry runs exist for this.
