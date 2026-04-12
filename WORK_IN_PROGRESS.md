# Work In Progress — Android Background TTS Playback

Last updated: 2026-04-12 (APK rebuilt and currently on device for testing)

---

## Problem being solved

**Android TTS player stops after every chapter when screen is off.**  
The user has to re-open the app for the next chapter to start. Works fine with screen on.

Expected behaviour: player advances through chapters indefinitely with screen off, no gaps.

---

## Current status

**APK has been rebuilt and installed on the test device. Currently testing.**

All code changes from this session are compiled into the running APK. Results pending.

To rebuild again if needed:
```
cd frontend
npx cap sync android
# Then open Android Studio and build, OR run the build script:
bash scripts/build-debug.sh
```

To watch live logs during testing:
```
adb logcat -s TtsPlayback
```

---

## Root causes found and fixed (this session)

### Bug 1 — Java queue always empty (PRIMARY BUG)
**File:** `frontend/android/app/src/main/java/com/truyenaudio/app/TtsPlaybackService.java`

**Race condition:** `mergeQueuedChapters` (JS→Java bridge) was posted to the Java `mainHandler` **before** `playChunksWithId` when chapter text took >50 ms to load from the network. `playChunks()` then called `chapterQueue.clear()`, nuking the chapters that were already queued. Result: queue always empty when ch1 ends.

**Fix:** Added `pendingMergeBuffer` field. `mergeQueue()` now checks `if (currentChunks == null && !isPlaying)` — if `playChunks` hasn't fired yet, it saves items into the buffer. `playChunks()` drains the buffer immediately after clearing the queue and resetting prefetch state.

Key lines in `TtsPlaybackService.java`:
- Field added around line 190: `private List<ChapterItem> pendingMergeBuffer = null;`
- Buffer drain in `playChunks()` after `pendingHead = 0` reset
- Buffer guard at the top of `mergeQueue()`
- Buffer cleared in `stopPlayback()`

### Bug 2 — `mergeQueuedChapters` never fires due to async loop cancellation
**File:** `frontend/app/books/[bookId]/listen/ListenPageClient.tsx`

**Problem:** The queue seeding effect had 6 preload text values as deps. Each time one loaded, the effect re-fired and set `cancelled=true` on the previous run. The async loop iterated ALL remaining chapters (99+) with sequential `await getCachedChapterText()` calls. Between awaits, a dep change set `cancelled=true`. The loop finished, the final `if (cancelled) return` fired, and `mergeQueuedChapters` was **never called**.

**Fix:**
1. Split into **Effect A** (`setPendingChapters` — only runs when `chapterId`/`allChapters` changes, NOT on preload text deps — prevents killing the Java self-fetch chain 6 times per chapter)
2. **Effect B** (`mergeQueuedChapters`) — added `if (cancelled) return` **inside the async loop** after every `await`
3. Loop now scans only **first 15 chapters** instead of all 99+

### Bug 3 — Self-fetch too slow on Railway cold starts
**File:** `frontend/android/app/src/main/java/com/truyenaudio/app/TtsPlaybackService.java`

Railway (the API host) takes 20–40 s to wake up from cold start. Java self-fetch used 30 s read timeout + 3 s retry = up to 66 s of silence between chapters.

**Fix:** When `awaitingFetch = true` (player is stalled waiting for next chapter):
- Connect timeout: 8 s (was 15 s)
- Read timeout: 12 s (was 30 s)
- Retry interval: 500 ms (was 3 000 ms)
- Total recovery: ~26 s (was ~66 s)

### Other improvements in this session
- JS preload extended from N+3 to **N+6** chapters ahead (gives Java 6 chapters of local buffer before self-fetch is needed)
- `mergeQueue()` accumulates multiple calls into the buffer (if JS calls it multiple times before playChunks fires, all are kept)

---

## Architecture overview

```
JS (React/Next.js in Capacitor WebView)
  │
  ├── ListenPageClient.tsx
  │     ├── Effect A: bridge.setPendingChapters(allRemainingChapters, apiBase, token)
  │     │     → gives Java the full ordered playlist for self-fetch
  │     └── Effect B: bridge.mergeQueuedChapters(chunksForN+1..N+6)
  │           → pushes pre-loaded chapter text directly into Java queue
  │
  ├── useNativeTTSPlayer.ts (in PlayerContext)
  │     └── bridge.playChunksWithId(currentChapterChunks, ...)
  │           → starts playback, clears + rebuilds queue from buffer
  │
  └── TtsBridge.java (JS interface)
        └── posts all calls to mainHandler (FIFO queue)

Java (TtsPlaybackService)
  ├── chapterQueue: LinkedList<ChapterItem>  — chapters ready to play immediately
  ├── pendingMergeBuffer: List<ChapterItem>  — NEW: buffer for pre-playChunks merges
  ├── pendingPlaylist: List<ChapterMeta>     — ordered chapter IDs for self-fetch
  └── doPrefetchStep()                       — self-fetches chapter text from Railway API
        when queue runs low or awaitingFetch=true
```

**Screen-off playback flow:**
1. JS sends chapters N+1..N+6 via `mergeQueuedChapters` → Java queue populated
2. JS sends full playlist via `setPendingChapters` → Java has self-fetch fallback
3. Screen turns off — WebView suspended
4. Java plays through queue (N+1→N+2→...→N+6) entirely in native
5. For N+7+: Java self-fetches from Railway API (no JS needed)
6. Screen turns on → JS processes queued events, syncs state, navigates to current chapter

---

## Files changed (uncommitted)

```
frontend/android/app/src/main/java/com/truyenaudio/app/TtsPlaybackService.java
frontend/app/books/[bookId]/listen/ListenPageClient.tsx
frontend/hooks/useNativeTTSPlayer.ts          ← earlier session fix (already committed?)
frontend/android/capacitor.settings.gradle    ← unrelated gradle change
```

Run `git diff --stat` to confirm exact list.

---

## Previously fixed bugs (earlier sessions — already in code)

| Bug | Location | Fix |
|-----|----------|-----|
| JS syntax error in `onChunkFinished` | TtsPlaybackService.java ~line 495 | Missing `'` before `}}` caused `native-tts-chapter-advance` event to be invalid JS |
| Watchdog reinit kills playback | TtsPlaybackService.java watchdog | Save `pendingItem` before `tts.shutdown()` so reinit replays the chapter |
| `tts.speak()` failure: 8 s wait | TtsPlaybackService.java `speakChunk` | Fast 1 s retry instead of waiting full watchdog interval |
| Reset effect stops native when ahead | useNativeTTSPlayer.ts reset effect | Added `nativeIsAhead` guard to prevent `stopPlayback()` when native is playing a future chapter |
| autoPlay section stops native when ahead | useNativeTTSPlayer.ts autoPlay section | Added third branch: if native is ahead, don't call `startNativePlayback` |
| Chapter texts never cached to IndexedDB | ListenPageClient.tsx | Added `cacheChapterText()` call after every API fetch; created `fetchAndCacheText` helper |

---

## Key file locations

| File | Purpose |
|------|---------|
| `frontend/android/app/src/main/java/com/truyenaudio/app/TtsPlaybackService.java` | Android foreground TTS service. All screen-off playback logic. |
| `frontend/android/app/src/main/java/com/truyenaudio/app/TtsBridge.java` | JS↔Java bridge (`window.TtsBridge`). Routes JS calls to service. |
| `frontend/hooks/useNativeTTSPlayer.ts` | React hook. Sends chunks to native, listens for events. |
| `frontend/app/books/[bookId]/listen/ListenPageClient.tsx` | Listen page. Seeds Java queue, handles visibility sync. |
| `frontend/context/PlayerContext.tsx` | Orchestrates both players. Holds track/voice/rate state. |
| `frontend/lib/chapterTextCache.ts` | IndexedDB store for chapter text (offline + screen-off buffer). |
| `frontend/lib/backgroundLock.ts` | `getTtsBridge()` helper + wake lock management. |
| `frontend/lib/constants.ts` | `API_URL` = `https://truyen-epub-audio-production.up.railway.app` |

---

## How to test the fix

1. Rebuild APK: `cd frontend && npx cap sync android` then build in Android Studio
2. Install on Android device
3. Open a book, navigate to a chapter, press play
4. Wait for playback to start, then turn screen off
5. Wait for chapter to finish (check via notification)
6. **Expected:** next chapter starts automatically without opening the app
7. Test with 3+ chapters in a row to verify the self-fetch path also works

**Debugging (adb logcat):**
```bash
adb logcat -s TtsPlayback
```
Look for:
- `playChunks: draining pendingMergeBuffer size=N` — confirms buffer fix working
- `mergeQueue: added=N total=M` — confirms chapters queued
- `chapterDone ch=X queue=N` — check queue size when chapter ends (should be >0)
- `doPrefetchStep: fetching ch=X` — self-fetch is running
- `→ fireDone` — BAD: means queue was empty AND self-fetch exhausted/failed

---

## Known remaining risks

1. **Railway cold start**: Even with shorter timeouts, the first self-fetch after a long idle period takes ~25 s. The 6-chapter JS buffer should cover this in practice.
2. **Token expiry**: The JWT passed to `setPendingChapters` for self-fetch is captured at call time. If the user plays for hours and the token expires, self-fetch gets HTTP 401 and retries forever. Chapters from the JS buffer still play fine (they don't need the token).
3. **Very short chapters**: If each chapter is <1 min, the 6-chapter buffer depletes quickly. Increase `next6Chapter` to `next10Chapter` in ListenPageClient if this is an issue.
