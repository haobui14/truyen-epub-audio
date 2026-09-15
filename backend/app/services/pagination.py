from collections.abc import Iterator


POSTGREST_MAX_ROWS = 1000


def capped_ranges(
    offset: int,
    limit: int,
    total: int,
    cap: int = POSTGREST_MAX_ROWS,
) -> Iterator[tuple[int, int]]:
    """Yield inclusive database ranges without crossing PostgREST's row cap."""
    cursor = max(0, offset)
    stop = min(max(0, total), cursor + max(0, limit))
    while cursor < stop:
        end = min(cursor + cap, stop) - 1
        yield cursor, end
        cursor = end + 1
