"""Content-type-aware gzip response compression.

Like Starlette's GZipMiddleware, but NEVER compresses Server-Sent Events
(`text/event-stream`) — buffering compressed SSE chunks in the gzip compressor
stalls the admin AI-fix token stream. Also skips responses that already set
`Content-Encoding`.

Why: chapter text is stored gzip-compressed in Storage, but the backend still
sends it to clients as PLAIN JSON over the wire. Compressing the HTTP response
shrinks `GET /api/chapters/{id}/text` (and the book/chapter list endpoints) ~3x
on the network. Biggest win is Android:

  * The native background self-fetch (TtsPlaybackService.doHttpGet) uses
    HttpURLConnection WITHOUT setting Accept-Encoding, so Android auto-negotiates
    gzip and transparently decompresses — the screen-off prefetch over cellular
    gets ~3x smaller payloads with ZERO APK change.
  * The WebView and web app get the same benefit via the browser's built-in
    transparent decompression.

The PWA service worker caches the already-decoded response, so offline caching is
unaffected.
"""
import gzip
import io

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Content types we must never gzip: SSE (needs unbuffered streaming). Everything
# else compressible (JSON, text) flows through normally.
_SKIP_CONTENT_TYPES = ("text/event-stream",)


class SmartGZipMiddleware:
    def __init__(self, app: ASGIApp, minimum_size: int = 512, compresslevel: int = 6) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.compresslevel = compresslevel

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and "gzip" in Headers(scope=scope).get("Accept-Encoding", ""):
            responder = _Responder(self.app, self.minimum_size, self.compresslevel)
            await responder(scope, receive, send)
            return
        await self.app(scope, receive, send)


class _Responder:
    """Mirrors Starlette's GZipResponder, with a `passthrough` escape hatch for
    SSE / already-encoded responses (decided from the response Content-Type)."""

    def __init__(self, app: ASGIApp, minimum_size: int, compresslevel: int) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.send: Send = _unset_send
        self.initial_message: Message = {}
        self.started = False
        self.passthrough = False
        self.buffer = io.BytesIO()
        self.gzip_file = gzip.GzipFile(mode="wb", fileobj=self.buffer, compresslevel=compresslevel)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        self.send = send
        await self.app(scope, receive, self._send)

    async def _send(self, message: Message) -> None:
        mtype = message["type"]

        if mtype == "http.response.start":
            # Buffer the start message until we see the body and know how to
            # rewrite the headers. Decide passthrough from the content-type.
            self.initial_message = message
            headers = Headers(raw=message["headers"])
            ct = headers.get("content-type", "")
            self.passthrough = (
                "content-encoding" in headers
                or any(ct.startswith(p) for p in _SKIP_CONTENT_TYPES)
            )
            return

        if mtype != "http.response.body":
            await self.send(message)
            return

        # Passthrough: emit start + every body chunk untouched (no buffering).
        if self.passthrough:
            if not self.started:
                self.started = True
                await self.send(self.initial_message)
            await self.send(message)
            return

        body = message.get("body", b"")
        more_body = message.get("more_body", False)

        if not self.started:
            self.started = True
            if len(body) < self.minimum_size and not more_body:
                # Too small to bother — send as-is.
                await self.send(self.initial_message)
                await self.send(message)
            elif not more_body:
                # Whole response in one chunk — standard gzip.
                self.gzip_file.write(body)
                self.gzip_file.close()
                gz = self.buffer.getvalue()
                headers = MutableHeaders(raw=self.initial_message["headers"])
                headers["Content-Encoding"] = "gzip"
                headers["Content-Length"] = str(len(gz))
                headers.add_vary_header("Accept-Encoding")
                message["body"] = gz
                await self.send(self.initial_message)
                await self.send(message)
            else:
                # First chunk of a streaming response — gzip incrementally.
                headers = MutableHeaders(raw=self.initial_message["headers"])
                headers["Content-Encoding"] = "gzip"
                headers.add_vary_header("Accept-Encoding")
                del headers["Content-Length"]
                self.gzip_file.write(body)
                message["body"] = self.buffer.getvalue()
                self.buffer.seek(0)
                self.buffer.truncate()
                await self.send(self.initial_message)
                await self.send(message)
            return

        # Subsequent streaming chunks.
        self.gzip_file.write(body)
        if not more_body:
            self.gzip_file.close()
        message["body"] = self.buffer.getvalue()
        self.buffer.seek(0)
        self.buffer.truncate()
        await self.send(message)


async def _unset_send(message: Message):
    raise RuntimeError("send awaitable not set")
