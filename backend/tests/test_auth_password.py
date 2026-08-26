"""Password hashing invariants after the passlib -> direct bcrypt swap.

The stored hashes are standard $2b$ strings produced by passlib; these tests
pin the properties that keep every existing account logging in: $2b$ format,
72-byte truncation (passlib's silent behaviour), and no exceptions on
malformed stored hashes.

Run from backend/:  python -m pytest tests/ -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.routers.auth import _hash_password, _verify_password  # noqa: E402


def test_roundtrip():
    h = _hash_password("mật khẩu bí mật")
    assert h.startswith("$2b$")
    assert _verify_password("mật khẩu bí mật", h)
    assert not _verify_password("sai mật khẩu", h)


def test_72_byte_truncation_matches_passlib_behaviour():
    # passlib silently truncated to bcrypt's 72-byte limit; a user whose
    # password is longer must still log in with either the full string or
    # its 72-byte prefix.
    long_pw = "x" * 100
    h = _hash_password(long_pw)
    assert _verify_password(long_pw, h)
    assert _verify_password("x" * 72, h)  # same first 72 bytes -> same hash


def test_malformed_stored_hash_is_wrong_password_not_crash():
    assert _verify_password("anything", "not-a-bcrypt-hash") is False
    assert _verify_password("anything", "") is False
