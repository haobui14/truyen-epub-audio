import httpx
import pytest

from app import database


@pytest.fixture
def flaky(monkeypatch):
    """Parent transport whose first request dies on a dropped connection."""
    calls = []

    def handle(self, request):
        calls.append(request.method)
        if len(calls) == 1:
            raise httpx.RemoteProtocolError("Server disconnected", request=request)
        return httpx.Response(200, request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", handle)
    return calls


def _send(method, headers=None):
    transport = database._RetryOnDeadConnection()
    return transport.handle_request(
        httpx.Request(method, "https://example.supabase.co/rest/v1/books", headers=headers)
    )


def test_get_is_resent_once(flaky):
    assert _send("GET").status_code == 200
    assert flaky == ["GET", "GET"]


def test_upsert_is_resent_once(flaky):
    resp = _send("POST", {"Prefer": "resolution=merge-duplicates,return=representation"})
    assert resp.status_code == 200
    assert flaky == ["POST", "POST"]


def test_plain_insert_is_not_resent(flaky):
    with pytest.raises(httpx.RemoteProtocolError):
        _send("POST", {"Prefer": "return=representation"})
    assert flaky == ["POST"]


def test_client_uses_http1_pool():
    client = database._http_client()
    pool = client._transport._pool
    assert pool._http1 is True and pool._http2 is False
    assert pool._keepalive_expiry == 50.0


def test_delete_is_not_resent(flaky):
    with pytest.raises(httpx.RemoteProtocolError):
        _send("DELETE")
    assert flaky == ["DELETE"]
