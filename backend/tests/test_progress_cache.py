import pytest

from _fakedb import FakeDb
from app import response_cache
from app.models.progress import ProgressUpsert
from app.routers import progress

USER = {"id": "u1", "email": "a@example.com", "role": "user"}


@pytest.fixture(autouse=True)
def _fresh_cache():
    response_cache.bump()
    yield
    response_cache.bump()


@pytest.fixture
def db(monkeypatch):
    def upsert(q):
        return [{
            "id": "p1", "user_id": q.payload["user_id"], "book_id": q.payload["book_id"],
            "chapter_id": q.payload["chapter_id"],
            "progress_value": q.payload["progress_value"],
            "total_value": q.payload["total_value"],
            "updated_at": "2026-10-28T12:00:00+00:00",
        }]

    fake = FakeDb({
        ("user_progress", "upsert"): upsert,
        ("chapters", "select"): lambda q: {"chapter_index": 7},
        ("user_progress", "select"): lambda q: None,
    })
    monkeypatch.setattr(progress, "get_client", lambda: fake)
    return fake


def _body(value, chapter="c7", total=50.0):
    return ProgressUpsert(book_id="b1", chapter_id=chapter, progress_value=value, total_value=total)


def test_unchanged_position_is_not_rewritten(db):
    first = progress.save_progress(_body(10), USER)
    second = progress.save_progress(_body(10), USER)
    assert first == second
    assert first["chapter_index"] == 7
    assert db.count("user_progress", "upsert") == 1


def test_changed_position_is_written(db):
    progress.save_progress(_body(10), USER)
    progress.save_progress(_body(11), USER)
    progress.save_progress(_body(11, chapter="c8"), USER)
    assert db.count("user_progress", "upsert") == 3
    # chapter_index is looked up once per chapter, not once per write.
    assert db.count("chapters", "select") == 2


def test_last_write_wins_across_devices(db):
    progress.save_progress(_body(10), USER)  # device A
    progress.save_progress(_body(3, chapter="c9"), USER)  # device B moves on
    progress.save_progress(_body(10), USER)  # device A again: must be written
    assert db.count("user_progress", "upsert") == 3


def test_book_progress_read_after_write_skips_db(db):
    saved = progress.save_progress(_body(10), USER)
    assert progress.get_book_progress("b1", USER) == saved
    assert db.count("user_progress", "select") == 0


def test_missing_book_progress_is_cached_until_a_write(db):
    assert progress.get_book_progress("b1", USER) is None
    assert progress.get_book_progress("b1", USER) is None
    assert db.count("user_progress", "select") == 1
    saved = progress.save_progress(_body(10), USER)
    assert progress.get_book_progress("b1", USER) == saved


def test_book_progress_flattens_embedded_chapter_index(monkeypatch):
    fake = FakeDb({
        ("user_progress", "select"): lambda q: {
            "id": "p1", "user_id": "u1", "book_id": "b1", "chapter_id": "c7",
            "progress_value": 4, "total_value": 9,
            "updated_at": "2026-10-28T12:00:00+00:00",
            "chapters": {"chapter_index": 7},
        },
    })
    monkeypatch.setattr(progress, "get_client", lambda: fake)
    row = progress.get_book_progress("b1", USER)
    assert row["chapter_index"] == 7 and "chapters" not in row
    assert len(fake.calls) == 1  # one query, no separate chapter lookup


def test_position_zero_always_writes(db):
    progress.save_progress(_body(0, total=None), USER)
    progress.save_progress(_body(0, total=None), USER)  # e.g. a reset
    assert db.count("user_progress", "upsert") == 2


def test_dedupe_only_inside_the_window(db, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(progress.time, "monotonic", lambda: now[0])
    progress.save_progress(_body(10), USER)
    now[0] += progress.DEDUPE_WINDOW_SECONDS + 1
    progress.save_progress(_body(10), USER)
    assert db.count("user_progress", "upsert") == 2


def test_cache_keeps_the_row_the_database_committed_last(monkeypatch):
    stamps = iter(["2026-10-28T12:00:05+00:00", "2026-10-28T12:00:01+00:00"])

    def upsert(q):
        return [{"id": "p1", "user_id": "u1", "book_id": "b1",
                 "chapter_id": q.payload["chapter_id"],
                 "progress_value": q.payload["progress_value"], "total_value": None,
                 "updated_at": next(stamps)}]

    fake = FakeDb({("user_progress", "upsert"): upsert,
                   ("chapters", "select"): lambda q: {"chapter_index": 1}})
    monkeypatch.setattr(progress, "get_client", lambda: fake)
    # The newer commit reaches the cache first, then a slower thread with an
    # older commit: the newer row must stay.
    progress.save_progress(_body(5, chapter="c-new", total=None), USER)
    progress.save_progress(_body(3, chapter="c-old", total=None), USER)
    assert progress.get_book_progress("b1", USER)["chapter_id"] == "c-new"


def test_cached_rows_never_leak_private_fields(db):
    progress.save_progress(_body(10), USER)
    assert not any(k.startswith("_") for k in progress.save_progress(_body(10), USER))
    assert not any(k.startswith("_") for k in progress.get_book_progress("b1", USER))
