import asyncio

from app.routers import stats


class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def execute(self):
        return type("Result", (), {"data": self._rows})()


class _FakeDb:
    def __init__(self, rows):
        self._rows = rows

    def table(self, name):
        assert name == "user_progress"
        return _FakeQuery(self._rows)


def test_exp_is_derived_from_progress(monkeypatch):
    rows = [
        # Mid-book: the 10 chapters before the current one count.
        {"books": {"total_chapters": 100}, "chapters": {"chapter_index": 10}},
        # On the last chapter: the whole book counts.
        {"books": {"total_chapters": 5}, "chapters": {"chapter_index": 4}},
        # Progress row whose chapter was deleted: ignored.
        {"books": {"total_chapters": 50}, "chapters": None},
    ]
    monkeypatch.setattr(stats, "get_client", lambda: _FakeDb(rows))

    out = stats.get_my_stats({"id": "u1"})

    assert out["chapters_completed"] == 15
    assert out["total_exp"] == 15 * stats.EXP_PER_CHAPTER
    assert out["total_chapters_read"] == 15
    assert out["total_chapters_listened"] == 0


def test_no_progress_means_zero_exp(monkeypatch):
    monkeypatch.setattr(stats, "get_client", lambda: _FakeDb([]))

    out = stats.get_my_stats({"id": "u1"})

    assert out["total_exp"] == 0
    assert out["chapters_completed"] == 0


def test_complete_chapter_is_a_noop():
    out = asyncio.run(stats.complete_chapter())

    assert out == {"exp_earned": 0, "already_completed": True, "total_exp": None}
