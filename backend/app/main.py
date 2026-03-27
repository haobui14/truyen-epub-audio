import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.services import task_queue
from app.routers import auth, books, chapters, progress, upload, tts, genres, stats
from app.routers import settings as settings_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: launch TTS queue worker
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
    if origin in settings.cors_origins:
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
