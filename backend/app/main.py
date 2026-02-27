import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.services import task_queue
from app.routers import books, chapters, upload, tts

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
    allow_origins=settings.allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)

app.include_router(books.router)
app.include_router(chapters.router)
app.include_router(upload.router)
app.include_router(tts.router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}
