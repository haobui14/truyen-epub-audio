import asyncio
import os
import tempfile
import logging
from concurrent.futures import ThreadPoolExecutor

from gtts import gTTS
from mutagen.mp3 import MP3

from app.utils.text_cleaner import split_text_for_tts

logger = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=2)


async def generate_audio(text: str, voice: str, output_path: str) -> float:
    """
    Generate MP3 audio from text using gTTS (Google Translate TTS).
    `voice` parameter is accepted for API compatibility but ignored —
    gTTS uses a single Vietnamese voice.
    Returns duration in seconds.
    Handles chunking for long texts.
    """
    chunks = split_text_for_tts(text, max_chars=5000)

    if len(chunks) == 1:
        await _generate_chunk(chunks[0], output_path)
    else:
        chunk_files = []
        try:
            for i, chunk in enumerate(chunks):
                tmp = tempfile.mktemp(suffix=f"_chunk{i}.mp3")
                await _generate_chunk(chunk, tmp)
                chunk_files.append(tmp)
            _concatenate_mp3s(chunk_files, output_path)
        finally:
            for f in chunk_files:
                if os.path.exists(f):
                    os.unlink(f)

    return _get_duration(output_path)


async def _generate_chunk(text: str, output_path: str) -> None:
    """Run gTTS in a thread pool (it's synchronous) with retry logic."""
    loop = asyncio.get_running_loop()
    for attempt in range(3):
        try:
            await loop.run_in_executor(
                _executor,
                lambda: gTTS(text=text, lang="vi").save(output_path),
            )
            return
        except Exception as e:
            logger.warning(f"gTTS attempt {attempt + 1} failed: {e}")
            if attempt < 2:
                await asyncio.sleep(2.0 * (attempt + 1))
            else:
                raise RuntimeError(f"gTTS failed after 3 attempts: {e}")


def _concatenate_mp3s(input_files: list[str], output_path: str) -> None:
    with open(output_path, "wb") as out:
        for path in input_files:
            with open(path, "rb") as f:
                out.write(f.read())


def _get_duration(mp3_path: str) -> float:
    try:
        audio = MP3(mp3_path)
        return audio.info.length
    except Exception:
        return 0.0
