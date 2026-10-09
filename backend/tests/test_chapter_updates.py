"""The homepage reflects successful story additions, never import/reparse dates."""

import asyncio
import io
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, UploadFile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.routers import books, upload
from app.services import epub_parser, storage_service
from scripts.repair_chapter_update_timestamps import apply_repairs, is_import_timestamp

STAMP = "2026-10-06T21:28:29+00:00"


def chapter(index, title=None):
    return {
        "id": f"chapter-{index}", "book_id": "book-1",
        "chapter_index": index, "title": title or f"Chapter {index + 1}",
        "text_content": "Chapter body.", "word_count": 2, "status": "pending",
        "created_at": STAMP, "updated_at": STAMP,
    }


class Database:
    def __init__(self, chapters=(), stamp=None, fail_insert=False):
        self.chapters = list(chapters)
        self.book = {"id": "book-1", "status": "ready", "last_chapter_added_at": stamp}
        self.updates = []
        self.fail_insert = fail_insert

    def table(self, name):
        return Query(self, name)


class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters = {}
        self.single = False
        self.action, self.values = "select", None

    def select(self, *args, **kwargs):
        return self

    def eq(self, key, value):
        self.filters[key] = value
        return self

    def maybe_single(self):
        self.single = True
        return self

    def order(self, *args, **kwargs):
        return self

    def range(self, *args):
        return self

    def limit(self, *args):
        return self

    def update(self, values):
        self.action, self.values = "update", values
        return self

    def insert(self, values):
        self.action, self.values = "insert", values
        return self

    def execute(self):
        if self.table == "books":
            if self.action == "update":
                if any(self.db.book.get(key) != value for key, value in self.filters.items()):
                    return SimpleNamespace(data=[])
                self.db.updates.append(self.values)
                self.db.book.update(self.values)
            return SimpleNamespace(data=dict(self.db.book) if self.single else [dict(self.db.book)])
        if self.action == "insert":
            if self.db.fail_insert:
                raise RuntimeError("Insert failed")
            rows = self.values if isinstance(self.values, list) else [self.values]
            rows = [{"created_at": STAMP, "updated_at": STAMP, **row} for row in rows]
            self.db.chapters.extend(rows)
            return SimpleNamespace(data=rows)
        rows = [row for row in self.db.chapters if all(row.get(key) == value for key, value in self.filters.items())]
        return SimpleNamespace(data=rows, count=len(rows))


@pytest.fixture
def mock_storage(monkeypatch):
    for name in ("upload_chapter_text", "upload_bytes", "delete_folder", "delete_chapter_text"):
        monkeypatch.setattr(storage_service, name, AsyncMock(return_value="storage/path"))


def append(monkeypatch, db, parsed, *, mode="auto"):
    monkeypatch.setattr(books, "get_client", lambda: db)
    monkeypatch.setattr(upload, "_to_epub_bytes", AsyncMock(return_value=b"epub"))
    monkeypatch.setattr(epub_parser, "extract_epub_contents", lambda *a, **kw: {"chapters": parsed})
    file = UploadFile(filename="chapters.txt", file=io.BytesIO(b"Chapter content"))
    return asyncio.run(books.append_chapters_from_file("book-1", file, mode, {}))


def test_successful_append_records_a_real_update(monkeypatch, mock_storage):
    db = Database([chapter(0)])
    result = append(monkeypatch, db, [chapter(0), chapter(1)])
    assert result["appended"] == 1
    assert db.book["last_chapter_added_at"] is not None
    assert db.book["total_chapters"] == 2


def test_duplicate_only_append_does_not_change_update_date(monkeypatch, mock_storage):
    db = Database([chapter(0)], stamp=STAMP)
    result = append(monkeypatch, db, [chapter(0)], mode="all")
    assert result["appended"] == 0
    assert db.book["last_chapter_added_at"] == STAMP
    assert db.updates == []


def test_initial_population_via_append_is_not_an_update(monkeypatch, mock_storage):
    db = Database()
    result = append(monkeypatch, db, [chapter(0)])
    assert result["appended"] == 1
    assert db.book["last_chapter_added_at"] is None


def test_failed_append_does_not_advertise_new_chapters(monkeypatch, mock_storage):
    db = Database([chapter(0)], stamp=STAMP, fail_insert=True)
    with pytest.raises(HTTPException):
        append(monkeypatch, db, [chapter(0), chapter(1)])
    assert db.book["last_chapter_added_at"] == STAMP
    assert db.updates == []


@pytest.mark.parametrize("existing_count", [0, 1])
def test_manual_add_records_update_only_after_initial_chapter(monkeypatch, mock_storage, existing_count):
    db = Database([chapter(i) for i in range(existing_count)])
    monkeypatch.setattr(books, "get_client", lambda: db)
    body = books.ChapterCreateBody(title="New chapter", chapter_index=existing_count, text_content="New body.")
    asyncio.run(books.create_chapter("book-1", body, {}))
    assert bool(db.book["last_chapter_added_at"]) == bool(existing_count)
    assert db.book["total_chapters"] == existing_count + 1


def test_failed_manual_add_preserves_previous_update_date(monkeypatch, mock_storage):
    db = Database([chapter(0)], stamp=STAMP, fail_insert=True)
    monkeypatch.setattr(books, "get_client", lambda: db)
    body = books.ChapterCreateBody(title="New chapter", chapter_index=1, text_content="New body.")
    with pytest.raises(HTTPException):
        asyncio.run(books.create_chapter("book-1", body, {}))
    assert db.book["last_chapter_added_at"] == STAMP
    assert db.updates == []


@pytest.mark.parametrize("previous_stamp", [None, STAMP])
def test_initial_import_and_reparse_do_not_mark_a_story_update(monkeypatch, mock_storage, previous_stamp):
    db = Database(stamp=previous_stamp)
    monkeypatch.setattr(epub_parser, "get_client", lambda: db)
    monkeypatch.setattr(epub_parser, "extract_epub_contents", lambda *a, **kw: {
        "title": "Book", "author": "Author", "chapters": [chapter(0)], "cover_bytes": None,
    })
    asyncio.run(epub_parser.parse_epub_task("book-1", b"epub"))
    assert db.book["status"] == "ready"
    assert db.book["last_chapter_added_at"] is None


def test_repair_distinguishes_import_dates_from_explicit_additions():
    assert is_import_timestamp(STAMP, STAMP)
    assert is_import_timestamp(STAMP, "2026-10-09T12:00:00+00:00")
    assert not is_import_timestamp("2026-10-06T21:28:30+00:00", STAMP)


def test_repair_saves_backup_and_preserves_a_concurrent_addition(tmp_path):
    import json

    original = {"id": "book-1", "title": "Book", "last_chapter_added_at": STAMP}
    backup = tmp_path / "repair.json"
    db = Database(stamp="2026-10-09T12:00:00+00:00")
    assert apply_repairs(db, [original], backup) == 0
    assert db.book["last_chapter_added_at"] == "2026-10-09T12:00:00+00:00"
    assert json.loads(backup.read_text(encoding="utf-8")) == [original]
    db.book["last_chapter_added_at"] = STAMP
    assert apply_repairs(db, [original], tmp_path / "repair-2.json") == 1
    assert db.book["last_chapter_added_at"] is None
