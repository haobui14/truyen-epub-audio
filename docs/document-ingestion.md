# TXT and PDF imports

The existing upload, append-chapters and reparse routes share the conversion
pipeline. No database migration or new API fields are needed. Deploy the backend
for parsing changes; rebuild the web/Android assets for the new upload guidance
and import-error display. Existing stored chapters are not changed automatically.

## TXT

- UTF-8 (with/without BOM), UTF-16 and UTF-32 with BOM are decoded strictly.
  BOM-less UTF-16 is recognized by its byte pattern.
- Windows Vietnamese (CP1258) combining tone marks are normalized to NFC.
  Other legacy files are checked against CP1252, CP1258, GB18030 and Big5.
  Encoding detection is heuristic; UTF-8 remains the best source format.
- Empty, binary, broken Unicode and replacement-character inputs report a
  readable error instead of silently substituting Latin-1 text.
- Numbered Vietnamese/ASCII, English/Roman and Chinese headings are recognized,
  including Markdown headings. Keep each heading on its own line.
- Without headings, paragraphs are grouped up to 5,000 words / 30,000 characters.
  Oversized paragraphs split at word boundaries when possible. Short tails,
  short chapters, numeric lines and preambles are retained.
- Contents entries with dot leaders do not create chapters. Consecutive headings
  without bodies are retained as text, without creating empty chapters.

## PDF

- Text blocks are read in geometric order. Repeated top/bottom margin text and
  margin page numbers are removed; body repetitions stay intact. Hard-wrapped
  lines are joined and line-ending hyphenation repaired within text blocks.
- OCR is selected per page for scans with little extractable text, broken text
  layers or dense vector outlines. Mixed digital/scanned documents retain page
  order. Blank digital pages and short digital chapters need no OCR.
- Tesseract with both `vie` and `eng` data is required for OCR (the deployment
  Dockerfile already installs these). PyMuPDF renders one page at a time, bounded
  to 12 megapixels / 4,096 pixels per side. OCR times out after 60 seconds per page.
- Locked/corrupt PDFs, missing OCR dependencies, timeouts and unreadable nonblank
  scans report errors. A required OCR failure does not publish a partial book.
- OCR text has no margin coordinates, so it is not subjected to destructive
  header/footer guessing. Complex columns, tables, illustrations, and poor scans
  still need review; OCR is not guaranteed to reproduce the source exactly.

The EPUB extraction step preserves the chapter boundaries already produced for
TXT/PDF. Its existing short-item and auto-split repair heuristics still apply to
ordinary EPUB imports.

## Verification

From `backend/`, run `python -m pytest tests/ -q`. Fixtures generate their own
PDFs in memory and do not connect to a database or upload book contents.

`.github/workflows/ingestion-tests.yml` runs the suite with real Tesseract. On
machines without the binary, only the real OCR smoke test is skipped; page
selection, memory limits, mixed-document order, and OCR failure paths still run
with controlled OCR results. Set `REQUIRE_INGESTION_OCR=1` to require the smoke
test locally too.
