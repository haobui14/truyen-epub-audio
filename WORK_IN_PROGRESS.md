# Work In Progress — Android Background TTS Playback

Last updated: 2026-04-12 (APK rebuilt and WORKING — background chapter auto-advance confirmed)

---

## Current status

**WORKING.** Background chapter auto-advance works with screen off and app not focused.
APK has been built and installed. User confirmed it is working.

To rebuild:
```
cd frontend
npx cap sync android
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

To watch live logs during testing:
```
adb logcat -s TtsPlayback
```

---

## Problem that was solved

**Android TTS player stopped after every chapter when screen is off / app not focused.**
The user had to reopen the app for the next chapter to start. Works fine with screen on.

---

## Architecture — how background playback works

```
JS (React/Next.js in Capacitor WebView)
  │
  ├── ListenPageClient.tsx
  │     ├── Effect A: bridge.setPendingChapters(allRemainingChapters, apiBase, token)
  │     │     → gives Java the full ordered playlist for self-fetch fallback
  │     └── Effect B: bridge.mergeQueuedChapters(chunksForUpTo50Chapters)
  │           → pushes pre-loaded chapter text directly into Java queue
  │
  ├── useNativeTTSPlayer.ts (in PlayerContext)
  │     └── bridge.playChunksWithId(currentChapterChunks, ...)
  │           → starts playback, clears + rebuilds queue from pendingMergeBuffer
  │
  └── TtsBridge.java (JS interface)
        └── posts all calls to mainHandler (FIFO queue on Android main thread)

Java (TtsPlaybackService)
  ├── chapterQueue: LinkedList<ChapterItem>  — chapters ready to play immediately (cap 50)
  ├── pendingMergeBuffer: List<ChapterItem>  — buffer for mergeQueue calls before playChunks
  ├── pendingPlaylist: List<ChapterMeta>     — ordered chapter IDs for self-fetch fallback
  └── doPrefetchStep()                       — self-fetches chapter text from Railway API
        when queue runs low or awaitingFetch=true
```

**Screen-off playback flow:**
1. User presses play (screen ON): JS calls `playChunksWithId(currentChapter)` → Java starts playing
2. JS Effect A: `setPendingChapters(allRemainingChapters)` → Java has full playlist for self-fetch
3. JS Effect B (50ms delay): reads up to 50 chapters from IndexedDB/React Query → `mergeQueuedChapters` → Java queue populated with up to 50 chapters of pre-loaded text
4. Screen turns off — WebView suspended, JS stops running
5. Java plays through queue entirely in native: ch1 → ch2 → ... → ch50
6. For ch51+: Java self-fetches from Railway API (no JS needed)
7. Screen turns on → JS processes queued events, syncs state, navigates to current chapter

---

## mainHandler call ordering (CRITICAL — do not break)

All JS→Java bridge calls are posted to the Android `mainHandler` (FIFO). The ordering
within a single React render cycle is guaranteed by React's effect execution order:

1. `useNativeTTSPlayer` reset effect (inside PlayerContext) fires first
   → `bridge.playChunksWithId(...)` posted → Java `playChunks()` runs first
2. ListenPageClient Effect A fires next (synchronous)
   → `bridge.setPendingChapters(...)` posted → Java `setPendingPlaylist()` runs second
3. ListenPageClient Effect B fires (async IIFE, 50ms delay)
   → `bridge.mergeQueuedChapters(...)` posted → Java `mergeQueue()` runs third

**Why this order matters:**
- `playChunks()` clears `chapterQueue` — it MUST run before `mergeQueue()`
- If `mergeQueue()` somehow arrives before `playChunks()`, `pendingMergeBuffer` catches it
  and `playChunks()` drains the buffer immediately after clearing the queue
- The 50ms delay in Effect B is a belt-and-suspenders measure for this race condition

**Do NOT:**
- Remove the `pendingMergeBuffer` mechanism in TtsPlaybackService.java
- Move Effect A or B earlier than `useNativeTTSPlayer`'s reset effect in the component tree
- Make Effect B synchronous (remove the `await new Promise(r => setTimeout(r, 50))`) without
  verifying that `playChunks` is always guaranteed to post first

---

## Critical rule: NO `status === "ready"` filter for native TTS queue

**This was the primary bug that caused chapters to not advance.**

Effects A and B in `ListenPageClient.tsx` must NOT filter chapters by `c.status === "ready"`.

**Why:** `status` refers to the **server-side TTS audio conversion** status (Railway generating
audio for the web player). It has NOTHING to do with whether the chapter has text content for
the native device TTS engine. Chapters with `status === "converting"` or `"error"` can still
have full text content that the device TTS can speak.

With the filter: if ANY chapters had `status !== "ready"`, Effect B sent 0 chapters to
`mergeQueuedChapters` → Java queue was always empty → `fireDone()` fired after every chapter
→ WebView received `native-tts-done` (deferred while suspended) → user opened app →
navigation happened → chapter started. Classic "need to open app" symptom.

**Correct filter for Effects A and B:**
```typescript
// CORRECT — no status filter
allChapters.filter((c) => c.chapter_index > currentIndex)

// WRONG — excludes chapters whose server audio isn't ready yet
allChapters.filter((c) => c.chapter_index > currentIndex && c.status === "ready")
```

The text availability check is implicit: Effect B's loop skips chapters where
`getCachedChapterText()` returns null. Java's `doPrefetchStep` skips empty chapters.

---

## Queue depth: 50 chapters

Effect B scans up to `.slice(0, 50)` chapters (matches Java's `chapterQueue` cap of 50).
With all chapters downloaded offline (IndexedDB), the queue is populated with up to 50
chapters at playback start → hours of screen-off playback before self-fetch is needed.

**Do NOT reduce this below ~20** — shorter queues cause audible gaps when Railway cold-starts
(self-fetch takes 20-40s on a cold Railway server). The queue is the buffer that hides this.

---

## Bugs fixed across all sessions

### Bug 1 — `status === "ready"` filter incorrectly excluded chapters (PRIMARY BUG)
**File:** `frontend/app/books/[bookId]/listen/ListenPageClient.tsx`

**Problem:** Effects A and B filtered with `c.status === "ready"`. For a book where server TTS
audio was still being generated, this sent 0 chapters to Java. Queue always empty.

**Fix:** Removed the status filter entirely. Text availability is checked implicitly by the
cache reads and Java's empty-chunk check.

### Bug 2 — Java queue always empty (race condition)
**File:** `TtsPlaybackService.java`

**Problem:** `mergeQueuedChapters` (JS→Java) arrived on mainHandler BEFORE `playChunksWithId`
when chapter text loaded fast. `playChunks()` called `chapterQueue.clear()`, nuking the
already-queued chapters.

**Fix:** Added `pendingMergeBuffer`. `mergeQueue()` buffers items when `currentChunks == null`.
`playChunks()` drains the buffer right after clearing the queue.

### Bug 3 — `mergeQueuedChapters` never fired due to async loop cancellation
**File:** `ListenPageClient.tsx`

**Problem:** Effect B had 6 preload text deps. Each load re-fired the effect, setting
`cancelled = true` on the previous run. The loop iterated ALL remaining chapters with
sequential IndexedDB awaits, getting cancelled mid-loop every time.

**Fix:** Added `if (cancelled) return` inside the loop after every `await`. Scan limit reduced
to 15 (now 50) so the loop finishes before the next dep change cancels it.

### Bug 4 — Self-fetch too slow on Railway cold starts
**File:** `TtsPlaybackService.java`

**Fix:** When `awaitingFetch = true`, shorter timeouts (8s connect / 12s read vs 15s/30s)
and 500ms retry interval (was 3000ms). Total recovery ~26s instead of ~66s.

### Bug 5 — Manual chapter navigation broken after native advance
**Files:** `ListenPageClient.tsx`, `TtsBridge.java`

**Problem:** `nativeIsAhead` guard prevented `stopPlayback()` even for user-initiated navigation.

**Fix:** `navigateTo(chapter, autoplay=false)` explicitly calls `bridge.stopPlayback()` before
navigating. `TtsBridge.stopPlayback()` also immediately sets `svc.isPlaying = false` (before
posting to mainHandler) so `bridge.isPlaying()` returns false right away.

### Previously fixed bugs (earlier sessions)
| Bug | Location | Fix |
|-----|----------|-----|
| JS syntax error in `onChunkFinished` | TtsPlaybackService.java | Missing `'` before `}}` |
| Watchdog reinit kills playback | TtsPlaybackService.java | Save `pendingItem` before TTS shutdown so reinit replays chapter |
| `tts.speak()` failure: 8s wait | TtsPlaybackService.java | Fast 1s retry instead of full watchdog interval |
| Reset effect stops native when ahead | useNativeTTSPlayer.ts | `nativeIsAhead` guard prevents `stopPlayback()` when native is in a future chapter |
| autoPlay section stops native when ahead | useNativeTTSPlayer.ts | Added third branch: if native is ahead, don't call `startNativePlayback` |
| Chapter texts never cached to IndexedDB | ListenPageClient.tsx | Added `cacheChapterText()` after every API fetch; created `fetchAndCacheText` helper |

---

## Key file locations

| File | Purpose |
|------|---------|
| `frontend/android/app/src/main/java/com/truyenaudio/app/TtsPlaybackService.java` | Android foreground TTS service. All screen-off playback logic. |
| `frontend/android/app/src/main/java/com/truyenaudio/app/TtsBridge.java` | JS↔Java bridge (`window.TtsBridge`). Routes JS calls to service. |
| `frontend/hooks/useNativeTTSPlayer.ts` | React hook. Sends chunks to native, listens for events. |
| `frontend/app/books/[bookId]/listen/ListenPageClient.tsx` | Listen page. Seeds Java queue (Effects A & B), handles visibility sync. |
| `frontend/context/PlayerContext.tsx` | Orchestrates both players. Holds track/voice/rate state. |
| `frontend/lib/chapterTextCache.ts` | IndexedDB store for chapter text (offline + screen-off buffer). |
| `frontend/lib/backgroundLock.ts` | `getTtsBridge()` helper + wake lock management. |
| `frontend/lib/constants.ts` | `API_URL` = Railway endpoint |

---

## Known remaining risks

1. **Railway cold start**: Even with shorter timeouts, first self-fetch after a long idle takes
   ~25s. The 50-chapter JS buffer covers this in practice.
2. **Token expiry**: JWT passed to `setPendingChapters` is captured at call time. If the user
   plays for hours and the token expires, self-fetch gets HTTP 401 and retries forever.
   Chapters from the JS-seeded queue still play (no token needed).
3. **Very short chapters**: If chapters are <1 min each, the 50-chapter buffer depletes in
   <50 min. Increase `.slice(0, 50)` if needed (Java cap is 50, so increasing beyond that
   requires also raising the `chapterQueue.size() >= 50` limit in `doPrefetchStep`).
