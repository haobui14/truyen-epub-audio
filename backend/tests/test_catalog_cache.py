"""Cached catalog/text endpoints: same JSON as before, fewer DB round-trips,
and a full body for any client that doesn't revalidate (old APKs, Java)."""
import pytest
from fastapi.testclient import TestClient

from _fakedb import FakeDb
from app import response_cache
from app.dependencies import get_approved_user
from app.main import app
from app.routers import books, chapters
from app.services import storage_service

BOOK = {
    "id": "b1",
    "title": "Truyện",
    "author": None,
    "description": None,
    "cover_url": None,
    "voice": "vi-VN-HoaiMyNeural",
    "status": "ready",
    "error_message": None,
    "total_chapters": 2,
    "created_at": "2026-10-01T00:00:00+00:00",
    "is_featured": False,
    "featured_label": None,
    "story_status": "ongoing",
    "last_chapter_added_at": None,
    "book_genres": [{"genres": {"id": "g1", "name": "Tiên hiệp", "color": "red"}}],
}
CHAPTERS = [
    {"id": f"c{i}", "book_id": "b1", "chapter_index": i, "title": f"Chương {i}",
     "word_count": 100, "status": "pending", "updated_at": "2026-10-02T00:00:00+00:00"}
    for i in range(2)
]


@pytest.fixture(autouse=True)
def _fresh_cache():
    response_cache.bump()
    yield
    response_cache.bump()
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    # Not used as a context manager, so the lifespan (DB startup jobs) is skipped.
    return TestClient(app)


def _book_db(status="ready"):
    book = {**BOOK, "status": status}
    return FakeDb({
        ("books", "select"): lambda q: (
            dict(book) if "id" in q.filters else [dict(book)]
        ),
        ("chapters", "select"): lambda q: [dict(c) for c in CHAPTERS],
    })


def test_book_list_served_from_cache_with_etag(monkeypatch, client):
    db = _book_db()
    monkeypatch.setattr(books, "get_client", lambda: db)

    first = client.get("/api/books")
    assert first.status_code == 200
    data = first.json()
    assert data[0]["id"] == "b1"
    assert data[0]["genres"] == [{"id": "g1", "name": "Tiên hiệp", "color": "red"}]
    assert "book_genres" not in data[0]
    etag = first.headers["etag"]

    second = client.get("/api/books")
    assert second.json() == data
    assert db.count("books", "select") == 1

    revalidated = client.get("/api/books", headers={"If-None-Match": etag})
    assert revalidated.status_code == 304
    assert db.count("books", "select") == 1


def test_book_list_with_a_parsing_book_is_not_cached(monkeypatch, client):
    db = _book_db(status="parsing")
    monkeypatch.setattr(books, "get_client", lambda: db)
    client.get("/api/books")
    client.get("/api/books")
    assert db.count("books", "select") == 2


def test_book_detail_cached_and_404_not_cached(monkeypatch, client):
    db = _book_db()
    monkeypatch.setattr(books, "get_client", lambda: db)
    assert client.get("/api/books/b1").json()["title"] == "Truyện"
    client.get("/api/books/b1")
    assert db.count("books", "select") == 1

    missing = FakeDb({("books", "select"): lambda q: None})
    monkeypatch.setattr(books, "get_client", lambda: missing)
    assert client.get("/api/books/nope").status_code == 404
    assert client.get("/api/books/nope").status_code == 404
    assert missing.count("books", "select") == 2


def test_chapter_list_payload_unchanged_and_cached(monkeypatch, client):
    db = _book_db()
    monkeypatch.setattr(books, "get_client", lambda: db)
    resp = client.get("/api/books/b1/chapters?page=1&page_size=1000")
    assert resp.json() == {
        "items": CHAPTERS, "total": 2, "page": 1, "page_size": 1000, "total_pages": 1,
    }
    client.get("/api/books/b1/chapters?page=1&page_size=1000")
    assert db.count("chapters", "select") == 1
    # A different page is a different cache entry.
    client.get("/api/books/b1/chapters?page=2&page_size=1")
    assert db.count("chapters", "select") == 2


def test_bump_drops_cached_catalog(monkeypatch, client):
    db = _book_db()
    monkeypatch.setattr(books, "get_client", lambda: db)
    client.get("/api/books")
    response_cache.bump()
    client.get("/api/books")
    assert db.count("books", "select") == 2


def _text_setup(monkeypatch, text):
    app.dependency_overrides[get_approved_user] = lambda: {"id": "u1", "role": "user"}
    db = FakeDb({
        ("chapters", "select"): lambda q: {
            "id": "c1", "text_storage_path": "b1/c1.txt",
            "updated_at": "2026-10-02T00:00:00+00:00",
        },
    })
    monkeypatch.setattr(chapters, "get_client", lambda: db)
    downloads = []

    async def fake_download(path, version=None):
        downloads.append(path)
        return text

    monkeypatch.setattr(storage_service, "download_chapter_text", fake_download)
    return db, downloads


def test_chapter_text_cached(monkeypatch, client):
    db, downloads = _text_setup(monkeypatch, "Nội dung chương")
    first = client.get("/api/chapters/c1/text")
    assert first.json() == {
        "id": "c1", "text_content": "Nội dung chương",
        "updated_at": "2026-10-02T00:00:00+00:00",
    }
    assert first.headers["cache-control"] == "private, no-cache"
    second = client.get("/api/chapters/c1/text")
    assert second.json() == first.json()
    assert db.count("chapters", "select") == 1 and len(downloads) == 1
    assert client.get(
        "/api/chapters/c1/text", headers={"If-None-Match": first.headers["etag"]}
    ).status_code == 304


def test_empty_chapter_text_is_never_cached(monkeypatch, client):
    db, downloads = _text_setup(monkeypatch, "")
    assert client.get("/api/chapters/c1/text").json()["text_content"] == ""
    client.get("/api/chapters/c1/text")
    assert len(downloads) == 2


def test_a_real_catalog_write_invalidates_cached_reads(monkeypatch, client):
    from app.dependencies import get_admin_user
    from app.routers import genres

    db = _book_db()
    monkeypatch.setattr(books, "get_client", lambda: db)
    genre_db = FakeDb({("genres", "insert"): lambda q: [{
        "id": "g2", "name": "Đô thị", "color": "blue", "created_at": "2026-10-28T00:00:00+00:00",
    }]})
    monkeypatch.setattr(genres, "get_client", lambda: genre_db)
    app.dependency_overrides[get_admin_user] = lambda: {"id": "admin", "role": "admin"}

    client.get("/api/books")
    client.get("/api/books")
    assert db.count("books", "select") == 1
    assert client.post("/api/genres", json={"name": "Đô thị", "color": "blue"}).status_code == 201
    client.get("/api/books")
    assert db.count("books", "select") == 2


# Writes that never touch books/chapters/genres/covers/chapter text. Anything
# else must live under a prefix the cache middleware watches — add new
# non-catalog writers here deliberately, catalog writers under those prefixes.
_NON_CATALOG_WRITES = (
    "/api/auth/", "/api/progress", "/api/settings", "/api/stats/",
    "/api/client-log", "/api/tts/",
)


def test_every_write_route_is_covered_by_cache_invalidation():
    from fastapi.routing import APIRoute

    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        if not (route.methods - {"GET", "HEAD", "OPTIONS"}):
            continue
        covered = route.path.startswith(response_cache._CATALOG_WRITE_PREFIXES)
        exempt = route.path.startswith(_NON_CATALOG_WRITES)
        assert covered or exempt, f"{route.methods} {route.path} bypasses cache invalidation"


def test_progress_put_through_the_response_model(monkeypatch, client):
    from app.dependencies import get_current_user
    from app.routers import progress

    app.dependency_overrides[get_current_user] = lambda: {"id": "u1", "email": "", "role": "user"}
    fake = FakeDb({
        ("user_progress", "upsert"): lambda q: [{
            "id": "p1", **{k: q.payload[k] for k in ("user_id", "book_id", "chapter_id", "progress_value", "total_value")},
            "updated_at": "2026-10-28T12:00:00+00:00",
        }],
        ("chapters", "select"): lambda q: {"chapter_index": 4},
    })
    monkeypatch.setattr(progress, "get_client", lambda: fake)
    body = {"book_id": "b1", "chapter_id": "c4", "progress_value": 12, "total_value": 40}
    first = client.put("/api/progress", json=body)
    second = client.put("/api/progress", json=body)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert set(first.json()) == {
        "id", "user_id", "book_id", "chapter_id", "progress_value", "total_value",
        "chapter_index", "updated_at",
    }
    assert fake.count("user_progress", "upsert") == 1
