package com.truyenaudio.app;

import java.util.Iterator;
import java.util.List;
import java.util.Queue;
import java.util.Set;
import java.util.function.Function;

/** Pure ordered-selection logic shared by the legacy and Media3 session paths. */
final class ChapterQueueController {
    private ChapterQueueController() {}

    static <T> T pollNext(
            Queue<T> queue,
            List<String> playlist,
            String currentId,
            Set<String> emptyIds,
            Function<T, String> idOf) {
        if (playlist != null && !playlist.isEmpty()
                && currentId != null && !currentId.isEmpty()) {
            int currentPosition = playlist.indexOf(currentId);
            if (currentPosition >= 0) {
                for (int index = currentPosition + 1; index < playlist.size(); index++) {
                    String nextId = playlist.get(index);
                    if (nextId == null || nextId.isEmpty() || emptyIds.contains(nextId)) continue;
                    for (Iterator<T> iterator = queue.iterator(); iterator.hasNext(); ) {
                        T item = iterator.next();
                        if (nextId.equals(idOf.apply(item))) {
                            iterator.remove();
                            return item;
                        }
                    }
                    // Never jump over a missing successor just because a later
                    // producer populated the queue first.
                    return null;
                }
                return null;
            }
        }
        return queue.poll();
    }
}
