package com.truyenaudio.app;

import java.util.List;

/** Immutable, content-time mapping between TTS chunks and media positions. */
final class ChapterTimeline {
    private static final float CHARS_PER_SECOND = 15f;
    private static final ChapterTimeline EMPTY = new ChapterTimeline(new long[0], 0);

    private final long[] startsMs;
    private final long durationMs;

    private ChapterTimeline(long[] startsMs, long durationMs) {
        this.startsMs = startsMs;
        this.durationMs = durationMs;
    }

    static ChapterTimeline fromChunks(List<String> chunks) {
        if (chunks == null || chunks.isEmpty()) return EMPTY;
        long[] starts = new long[chunks.size()];
        long duration = 0;
        for (int index = 0; index < chunks.size(); index++) {
            starts[index] = duration;
            String chunk = chunks.get(index);
            duration += (long) ((chunk == null ? 0 : chunk.length())
                    / CHARS_PER_SECOND * 1000f);
        }
        return new ChapterTimeline(starts, duration);
    }

    long durationMs() {
        return durationMs;
    }

    long positionForChunk(int chunkIndex) {
        if (startsMs.length == 0 || chunkIndex < 0) return 0;
        if (chunkIndex >= startsMs.length) return durationMs;
        return startsMs[chunkIndex];
    }

    int chunkForPosition(long positionMs) {
        for (int index = startsMs.length - 1; index >= 0; index--) {
            if (startsMs[index] <= positionMs) return index;
        }
        return 0;
    }
}
