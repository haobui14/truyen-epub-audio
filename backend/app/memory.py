"""glibc heap tuning. Railway bills memory by the GB-minute and it is nearly
all of this service's cost (CPU sits near zero), while RSS idled around
0.5 GB: big transient allocations (EPUB parses, bulk text rewrites, upload
buffers) are freed by Python but glibc keeps the pages, spread over one
malloc arena per thread that ever allocated.

No-ops anywhere but Linux/glibc, so local Windows/macOS runs are unaffected.
"""
import ctypes
import ctypes.util
import logging
import sys

logger = logging.getLogger(__name__)

_M_ARENA_MAX = -8  # from glibc's malloc.h
_libc = None


def _load_libc():
    global _libc
    if _libc is None and sys.platform.startswith("linux"):
        try:
            _libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
            _libc.malloc_trim  # glibc only (absent on musl)
        except (OSError, AttributeError):
            _libc = False
    return _libc or None


def limit_arenas(max_arenas: int = 2) -> None:
    """Same as MALLOC_ARENA_MAX=2. Must run before worker threads start
    allocating, i.e. at import time of the app."""
    libc = _load_libc()
    if libc is not None:
        libc.mallopt(_M_ARENA_MAX, max_arenas)


def trim() -> None:
    """Hand freed heap pages back to the OS."""
    libc = _load_libc()
    if libc is not None:
        libc.malloc_trim(0)
