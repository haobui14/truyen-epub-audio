package com.truyenaudio.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
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

    @Test public void progressSyncCollapsesQueuedValuesToLatest() {
        Queue<Runnable> tasks = new ArrayDeque<>();
        List<Integer> sent = new ArrayList<>();
        LatestProgressSync<Integer> sync = new LatestProgressSync<>(
                tasks::add, sent::add, error -> {});

        sync.submit(500);
        sync.submit(650);
        sync.submit(700);
        assertEquals(1, tasks.size());

        tasks.remove().run();
        assertEquals(Collections.singletonList(700), sent);
    }

    @Test public void progressSyncSerializesValueSubmittedDuringSend() {
        Queue<Runnable> tasks = new ArrayDeque<>();
        List<Integer> sent = new ArrayList<>();
        @SuppressWarnings("unchecked")
        LatestProgressSync<Integer>[] holder = new LatestProgressSync[1];
        holder[0] = new LatestProgressSync<>(tasks::add, value -> {
            sent.add(value);
            if (value == 500) holder[0].submit(700);
        }, error -> {});

        holder[0].submit(500);
        tasks.remove().run();
        assertEquals(Arrays.asList(500, 700), sent);
        assertEquals(0, tasks.size());
    }

    @Test public void failedProgressIsSupersededByNextValue() {
        Queue<Runnable> tasks = new ArrayDeque<>();
        List<Integer> sent = new ArrayList<>();
        LatestProgressSync<Integer> sync = new LatestProgressSync<>(
                tasks::add,
                value -> {
                    if (value == 500) throw new java.io.IOException("offline");
                    sent.add(value);
                },
                error -> {});

        sync.submit(500);
        tasks.remove().run();
        sync.submit(700);
        tasks.remove().run();
        assertEquals(Collections.singletonList(700), sent);
    }
}
