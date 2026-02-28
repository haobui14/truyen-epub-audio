"use client";
// Server-side TTS pre-conversion is no longer used.
// Audio is generated live via /api/tts/speak with client-side chapter preloading.
// This hook is kept as a no-op to avoid breaking any imports.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function usePrefetch(_bookId: string | null, _currentChapterIndex: number | null) {
  // no-op
}
