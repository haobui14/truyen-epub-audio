package com.truyenaudio.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Collections;
import java.util.Queue;

import org.junit.Test;

public class PlaybackControllersTest {
    private static final class Item {
        final String id;
        Item(String id) { this.id = id; }
    }

    @Test public void orderedQueueWaitsForMissingImmediateSuccessor() {
        Queue<Item> queue = new ArrayDeque<>();
        queue.add(new Item("10"));
        assertNull(ChapterQueueController.pollNext(
                queue, Arrays.asList("5", "6", "10"), "5",
                Collections.emptySet(), item -> item.id));
        assertEquals(1, queue.size());
    }

    @Test public void orderedQueueSkipsKnownEmptyAndRemovesSelectedItem() {
        Queue<Item> queue = new ArrayDeque<>();
        queue.add(new Item("9"));
        queue.add(new Item("7"));
        Item selected = ChapterQueueController.pollNext(
                queue, Arrays.asList("5", "6", "7", "9"), "5",
                Collections.singleton("6"), item -> item.id);
        assertEquals("7", selected.id);
        assertEquals(1, queue.size());
    }

    @Test public void timelineMapsPositionsToChunkBoundaries() {
        ChapterTimeline timeline = ChapterTimeline.fromChunks(
                Arrays.asList("123456789012345", "123456789012345678901234567890"));
        assertEquals(0, timeline.positionForChunk(0));
        assertEquals(1_000, timeline.positionForChunk(1));
        assertEquals(3_000, timeline.durationMs());
        assertEquals(0, timeline.chunkForPosition(999));
        assertEquals(1, timeline.chunkForPosition(1_000));
    }
}
