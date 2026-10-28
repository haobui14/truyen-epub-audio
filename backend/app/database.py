import httpx
from supabase import create_client, Client
from supabase.lib.client_options import SyncClientOptions
from app.config import settings

_client: Client | None = None

# Methods safe to resend when a pooled connection turns out to be dead.
# PostgREST upserts are POSTs, so they are recognised by their Prefer header.
# DELETE is left out: a resend after a delete that did land returns no rows,
# which callers read as "not found".
_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PUT", "PATCH"})


class _RetryOnDeadConnection(httpx.HTTPTransport):
    """Resend an idempotent request once when the server dropped the pooled
    connection under it ("Server disconnected"). That error used to surface as
    an unhandled 500 on whichever endpoint drew the dead connection."""

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return super().handle_request(request)
        except (httpx.RemoteProtocolError, httpx.ReadError, httpx.WriteError):
            idempotent = request.method in _IDEMPOTENT_METHODS or (
                "resolution=merge-duplicates" in request.headers.get("prefer", "")
            )
            if not idempotent:
                raise
            return super().handle_request(request)


def _http_client() -> httpx.Client:
    # HTTP/1.1, not postgrest's default HTTP/2: the sync HTTP/2 client shares
    # one connection across every worker thread, and when Supabase's gateway
    # drops it, every in-flight query fails together. httpx's default 5s
    # keep-alive also meant most queries paid a fresh TCP+TLS handshake to a
    # server in another region; 50s keeps the connection warm between requests.
    # Pool settings belong to the transport: httpx ignores Client(limits=...)
    # once a custom transport is passed. retries= only covers connect failures.
    transport = _RetryOnDeadConnection(
        http1=True,
        http2=False,
        retries=2,
        limits=httpx.Limits(
            max_connections=32, max_keepalive_connections=16, keepalive_expiry=50.0
        ),
    )
    return httpx.Client(
        timeout=httpx.Timeout(120.0, connect=10.0),
        transport=transport,
        follow_redirects=True,
    )


def get_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(
            settings.supabase_url,
            settings.supabase_secret_key,
            options=SyncClientOptions(httpx_client=_http_client()),
        )
    return _client
