import asyncio

import pytest
from starlette.requests import Request

from app import response_cache as rc


@pytest.fixture(autouse=True)
def _fresh_cache():
    rc.bump()
    yield
    rc.bump()


def _request(headers=None):
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw})


def test_put_get_and_ttl(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(rc.time, "monotonic", lambda: now[0])
    store = rc.Store(max_entries=10)
    store.put("k", "v", ttl=60, gen=rc.generation())
    assert store.get("k") == "v"
    now[0] += 61
    assert store.get("k") is None


def test_purge_expired_frees_entries_nobody_reads(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(rc.time, "monotonic", lambda: now[0])
    store = rc.Store(max_entries=10)
    gen = rc.generation()
    store.put("old", 1, ttl=10, gen=gen)
    store.put("new", 2, ttl=100, gen=gen)
    now[0] += 50
    store.purge_expired()
    assert list(store._data) == ["new"]


def test_put_is_dropped_when_a_write_bumped_mid_read():
    store = rc.Store(max_entries=10)
    gen = rc.generation()  # read starts
    rc.bump()  # a write lands while the query is in flight
    store.put("k", "stale", ttl=60, gen=gen)
    assert store.get("k") is None


def test_bump_clears_every_store():
    gen = rc.generation()
    rc.catalog.put("a", 1, ttl=60, gen=gen)
    rc.texts.put("b", 2, ttl=60, gen=gen)
    rc.progress.put("c", 3, ttl=60, gen=gen)
    rc.bump()
    assert rc.catalog.get("a") is None
    assert rc.texts.get("b") is None
    assert rc.progress.get("c") is None


def test_only_if_absent_keeps_the_newer_row():
    store = rc.Store(max_entries=10)
    gen = rc.generation()
    store.put("k", "written", ttl=60, gen=gen)
    store.put("k", "slow read", ttl=60, gen=gen, only_if_absent=True)
    assert store.get("k") == "written"


def test_lru_evicts_oldest():
    store = rc.Store(max_entries=2)
    gen = rc.generation()
    store.put("a", 1, ttl=60, gen=gen)
    store.put("b", 2, ttl=60, gen=gen)
    store.get("a")  # a is now most recent
    store.put("c", 3, ttl=60, gen=gen)
    assert store.get("b") is None
    assert store.get("a") == 1 and store.get("c") == 3


def test_conditional_json_full_body_without_validator():
    body = b'{"x":1}'
    etag = rc.etag_for(body)
    resp = rc.conditional_json(_request(), body, etag)
    assert resp.status_code == 200
    assert resp.body == body
    assert resp.headers["etag"] == etag
    assert resp.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("sent", ["{etag}", "{bare}", '"other", {etag}', "*"])
def test_conditional_json_304_on_match(sent):
    body = b'{"x":1}'
    etag = rc.etag_for(body)
    header = sent.format(etag=etag, bare=etag.removeprefix("W/"))
    resp = rc.conditional_json(_request({"If-None-Match": header}), body, etag)
    assert resp.status_code == 304
    assert resp.body == b""
    assert resp.headers["etag"] == etag


def test_conditional_json_200_on_stale_validator():
    body = b'{"x":2}'
    resp = rc.conditional_json(
        _request({"If-None-Match": rc.etag_for(b'{"x":1}')}), body, rc.etag_for(body)
    )
    assert resp.status_code == 200


async def _noop_app(scope, receive, send):
    pass


@pytest.mark.parametrize(
    "method,path,bumps",
    [
        ("POST", "/api/books/b1/append-chapters", 2),
        ("PATCH", "/api/chapters/c1/text", 2),
        ("DELETE", "/api/genres/g1", 2),
        ("POST", "/api/upload", 2),
        ("GET", "/api/books", 0),
        ("PUT", "/api/progress", 0),
        ("POST", "/api/auth/refresh", 0),
    ],
)
def test_middleware_bumps_only_around_catalog_writes(method, path, bumps):
    mw = rc.CacheInvalidationMiddleware(_noop_app)
    before = rc.generation()
    asyncio.run(mw({"type": "http", "method": method, "path": path}, None, None))
    assert rc.generation() - before == bumps


def test_middleware_bumps_even_when_the_write_fails():
    async def boom(scope, receive, send):
        raise RuntimeError("db down")

    mw = rc.CacheInvalidationMiddleware(boom)
    before = rc.generation()
    with pytest.raises(RuntimeError):
        asyncio.run(mw({"type": "http", "method": "POST", "path": "/api/books/x/reparse"}, None, None))
    assert rc.generation() - before == 2


def test_byte_budget_evicts_oldest_and_skips_oversized():
    store = rc.Store(max_entries=100, max_bytes=1000)
    gen = rc.generation()
    store.put("a", (b"x" * 200, "e"), ttl=60, gen=gen)
    store.put("b", (b"x" * 200, "e"), ttl=60, gen=gen)
    store.put("huge", (b"x" * 400, "e"), ttl=60, gen=gen)  # > max_bytes/4: not cached
    assert store.get("huge") is None
    for k in "cdefgh":
        store.put(k, (b"x" * 200, "e"), ttl=60, gen=gen)
    assert store.get("a") is None and store.get("h") is not None
    assert store._bytes <= 1000


def test_replaces_predicate_guards_overwrites():
    store = rc.Store(max_entries=10)
    gen = rc.generation()
    store.put("k", {"v": 2}, ttl=60, gen=gen)
    store.put("k", {"v": 1}, ttl=60, gen=gen, replaces=lambda old: old["v"] <= 1)
    assert store.get("k") == {"v": 2}
    store.put("k", {"v": 3}, ttl=60, gen=gen, replaces=lambda old: old["v"] <= 3)
    assert store.get("k") == {"v": 3}


def test_tracked_task_bumps_when_done_and_is_kept_alive():
    async def main():
        async def work():
            await asyncio.sleep(0)
        task = asyncio.create_task(work())
        rc.bump_when_done(task)
        assert task in rc._tracked_tasks
        before = rc.generation()
        await task
        await asyncio.sleep(0)  # let the done callback run
        return before

    before = asyncio.run(main())
    assert rc.generation() == before + 1
    assert not rc._tracked_tasks
