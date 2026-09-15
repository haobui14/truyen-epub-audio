from app.services.pagination import capped_ranges


def test_large_logical_page_is_split_at_postgrest_cap():
    assert list(capped_ranges(offset=0, limit=10_000, total=1_001)) == [
        (0, 999),
        (1000, 1000),
    ]


def test_later_logical_page_keeps_absolute_offsets():
    assert list(capped_ranges(offset=2_000, limit=2_000, total=4_500)) == [
        (2000, 2999),
        (3000, 3999),
    ]


def test_range_stops_at_total_chapter_count():
    assert list(capped_ranges(offset=4_000, limit=1_000, total=4_250)) == [
        (4000, 4249),
    ]
