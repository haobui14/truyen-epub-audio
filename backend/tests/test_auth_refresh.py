from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from _fakedb import FakeDb
from app.routers import auth


def _db(expires_in_days, user=True):
    expires_at = (datetime.now(timezone.utc) + timedelta(days=expires_in_days)).isoformat()
    return FakeDb({
        ("refresh_tokens", "select"): lambda q: {
            "user_id": "u1",
            "expires_at": expires_at,
            "users": (
                {"email": "a@example.com", "display_name": "A", "avatar_base64": "data:x"}
                if user else None
            ),
        },
        ("refresh_tokens", "insert"): lambda q: [q.payload],
        ("refresh_tokens", "delete"): lambda q: [],
    })


@pytest.fixture(autouse=True)
def _approved(monkeypatch):
    monkeypatch.setattr(auth, "lookup_approval", lambda user_id: "approved")
    monkeypatch.setattr(auth, "_lookup_role", lambda user_id: "user")


def test_young_token_is_handed_back_without_writes(monkeypatch):
    db = _db(expires_in_days=89)
    monkeypatch.setattr(auth, "get_client", lambda: db)
    out = auth.refresh(auth.RefreshRequest(refresh_token="tok"))
    assert out.refresh_token == "tok"
    assert out.email == "a@example.com" and out.avatar_base64 == "data:x"
    assert out.access_token
    assert [c[1] for c in db.calls] == ["select"]


def test_week_old_token_rotates_and_prunes(monkeypatch):
    db = _db(expires_in_days=80)
    monkeypatch.setattr(auth, "get_client", lambda: db)
    out = auth.refresh(auth.RefreshRequest(refresh_token="tok"))
    assert out.refresh_token != "tok"
    assert db.count("refresh_tokens", "insert") == 1
    assert db.count("refresh_tokens", "delete") == 1


def test_token_without_user_is_rejected(monkeypatch):
    db = _db(expires_in_days=89, user=False)
    monkeypatch.setattr(auth, "get_client", lambda: db)
    with pytest.raises(HTTPException) as err:
        auth.refresh(auth.RefreshRequest(refresh_token="tok"))
    assert err.value.status_code == 401
