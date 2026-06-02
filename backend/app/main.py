import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.database import get_client
from app.services import task_queue
from app.routers import auth, books, chapters, progress, upload, tts, genres, stats
from app.routers import settings as settings_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# A book sits in status='parsing' only while an in-memory asyncio task parses
# it. If the process dies mid-parse (deploy / crash / OOM), that task is lost
# and the book is stuck in 'parsing' forever. Anything older than this on
# startup is assumed orphaned — a real parse never takes this long (the slow
# TTS phase runs under status='converting', not 'parsing').
STUCK_PARSING_MINUTES = 30


def _recover_stuck_parsing_books() -> None:
    """Mark books orphaned in 'parsing' (interrupted by a restart) as 'error'
    so they surface in the admin UI and can be re-parsed from the stored
    original. Best-effort: never blocks startup."""
    try:
        db = get_client()
        cutoff = (
            datetime.now(timezone.utc) - timedelta(minutes=STUCK_PARSING_MINUTES)
        ).isoformat()
        res = (
            db.table("books")
            .update({
                "status": "error",
                "error_message": (
                    "Quá trình phân tích bị gián đoạn (máy chủ khởi động lại). "
                    'Bấm "Phân tích lại" để thử lại từ file gốc.'
                ),
            })
            .eq("status", "parsing")
            .lt("created_at", cutoff)
            .execute()
        )
        n = len(res.data or [])
        if n:
            logger.warning("Recovered %d book(s) stuck in 'parsing'", n)
    except Exception as e:
        # A missing error_message column (migration not run yet) or any DB
        # hiccup must not stop the app from starting.
        logger.warning("Stuck-parsing recovery skipped: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: recover orphaned parses, then launch TTS queue worker
    _recover_stuck_parsing_books()
    await task_queue.start_worker()
    logger.info("Application started")
    yield
    # Shutdown
    logger.info("Application shutting down")


app = FastAPI(
    title="Truyện Audio API",
    description="Vietnamese EPUB to Audio conversion API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    max_age=3600,
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error: %s", exc)
    origin = request.headers.get("origin", "")
    headers = {}
    # Always echo the requesting origin back so Capacitor WebViews (https://localhost)
    # can read the error body even when the origin isn't in the configured allow-list.
    # A 500 response is never cacheable, so reflecting the origin is safe here.
    if origin:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers=headers,
    )

app.include_router(auth.router)
app.include_router(books.router)
app.include_router(chapters.router)
app.include_router(upload.router)
app.include_router(tts.router)
app.include_router(progress.router)
app.include_router(settings_router.router)
app.include_router(genres.router)
app.include_router(stats.router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}
