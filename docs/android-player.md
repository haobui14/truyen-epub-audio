# Android TTS Player — Architecture Reference

This document is the source of truth for the native Android player's state machine.
When editing any of these files, verify your change does not violate an invariant below.

**Files this document covers:**
- `frontend/android/app/src/main/java/com/truyenaudio/app/TtsPlaybackService.java` — the foreground service
- `frontend/android/app/src/main/java/com/truyenaudio/app/TtsBridge.java` — JS↔Java bridge
- `frontend/hooks/useNativeTTSPlayer.ts` — React hook
- `frontend/context/PlayerContext.tsx` — unified player context
- `frontend/app/books/[bookId]/listen/ListenPageClient.tsx` — listen page

See `memory/project_tts_state_machine.md` for the bug-fix history that shaped this design.

---

## 1. State inventory

### Java (`TtsPlaybackService`, main-thread unless noted)

| Field | Type | Volatile? | Mutators | Meaning |
|---|---|---|---|---|
| `isPlaying` | boolean | yes | `playChunks`, `resumePlayback`, `pauseInternal`, `stopPlayback`, `startChapter`, `fireDone`, `skipToNextChapter`, `TtsBridge.stopPlayback` (sync from WebView thread) | TTS engine currently speaking |
| `currentChunkIdx` | int | yes | `speakChunk`, `stopPlayback` | Index of chunk currently speaking |
| `currentChapterId` | String | yes | `playChunks`, `startChapter`, `stopPlayback` | UUID of playing chapter |
| `currentChunks` | List<String> | no | `playChunks`, `startChapter`, `stopPlayback` | Text chunks of current chapter |
| `currentRate`/`currentPitch`/`currentTitle` | float/float/String | no | `playChunks`, `startChapter`, `setRate`, `setPitch`, `updateTitle` | TTS params |
| `chapterQueue` | Queue<ChapterItem> | no | `mergeQueue`, `queueAllChapters`, `playChunks` (clear), `stopPlayback` (clear), `onChunkFinished` (poll), `skipToNextChapter` (poll), `doPrefetchStep` (add) | Upcoming chapters for seamless auto-advance |
| `pendingMergeBuffer` | List<ChapterItem>?  | no | `mergeQueue` (buffer), `playChunks` (drain) | Chapters that arrived via mergeQueue BEFORE playChunks ran |
| `completedChapterIds` | List<String> | no, locked | `onChunkFinished`, `deliverAutoAdvance` (add), `getAndClearCompletedChapterIds` (clear) | Chapters finished via auto-advance; consumed by JS for XP/progress sync |
| `pendingPlaylist` | List<ChapterMeta> | no | `setPendingPlaylist` | Ordered upcoming chapters; self-fetch source |
| `pendingHead` | int | no | `setPendingPlaylist` (=0), `doPrefetchStep` (skip-loop, advance on fetch), `stopPlayback` (=0), `onChunkFinished` FAILSAFE, `rescanPendingHead` | Index into pendingPlaylist of next chapter to fetch |
| `selfFetchBase`/`selfFetchToken` | String | no | `setPendingPlaylist` | HTTP base URL + bearer token |
| `awaitingFetch` | boolean | no | `onChunkFinished` (=true), `deliverAutoAdvance` (=false), `stopPlayback` (=false), `playChunks` (=false), `doPrefetchStep` (=false on deliver/exhaust) | Chapter ended with empty queue, waiting for fetch/merge result |
| `prefetchVersion` | int | no | `playChunks`, `setPendingPlaylist`, `stopPlayback` (all ++) | Monotonic; stale ioExecutor callbacks check & discard |
| `prefetchActive` | boolean | no | `kickPrefetch` (=true), `doPrefetchStep` (false on exhaust/stale/error) | Fetch chain is in flight on ioExecutor |
| `autoAdvancing` | boolean | no | `deliverAutoAdvance` (wraps startChapter) | Suppresses `playFakeSilence` + MediaSession reassertion during chapter transition |
| `pausedByTransientLoss` | boolean | no | audio-focus listener | If true, auto-resume on focus gain |
| `hasFocus` | boolean | no | audio-focus listener | Track if we hold audio focus |
| `sessionWanted` | boolean | no | `requestAudioFocus` (=true), `stopPlayback` / AUDIOFOCUS_LOSS (=false) | Guards `reassertMediaSession`'s staggered re-assertions: never re-activate a session we deliberately gave up |
| `currentTitle`/`currentTotalChunks`/`currentBookId` | String/int/String | **yes** | `playChunks`, `startChapter`, `setSessionInfo`, `restoreSession` | Read from the WebView JS thread via bridge getters (MiniPlayer override, BookDetail resume) |
| `currentBookTitle` | String | no | `setSessionInfo`, `restoreSession` | MediaSession ARTIST/ALBUM + notification subtitle |
| `restoredWasPlaying`/`restoredAtMs`/`autoResumeConsumed` | bool/long/bool | no | `restoreSession`, `onStartCommand` | START_STICKY auto-resume gating (<2 min kill→restart gap) |
| `restoringSession` | boolean | no | `resumeFromRestoredSession` | Restore text-fetch in flight; async callback validates chapter/playing before starting |
| `lastProgressSyncMs` | long | no | `maybeSyncProgressToServer` | 30 s throttle for background server progress PUTs |
| `ttsReady` | boolean | no | `initTts` onInit | TTS engine initialized |
| `pendingItem`/`pendingStartIdx` | ChapterItem?/int | no | `playChunks` (when !ttsReady), `initTts` onInit (consume) | Defer playback until TTS engine ready |
| `watchdogRetries` | int | no | `speakChunk`, `watchdogRunnable` | Retry count for stalled TTS engine |

### Java Bridge (`TtsBridge`, WebView-thread & main-thread)

| Field | Mutators | Purpose |
|---|---|---|
| `service` | `onServiceConnected`, `onServiceDisconnected` | Bound service reference |
| `bound` | `doBindService`, `stopService` | Binding state |
| `pendingChunks`/`pendingRate`/…/`pendingChapterId` | `playChunksWithId` (when !bound), `onServiceConnected` (consume) | Buffered play command |
| `pendingMergeItems` | `mergeQueuedChapters` (when !bound), `onServiceConnected` | Buffered merge items |
| `pendingPlaylistMeta`/`…Base`/`…Token` | `setPendingChapters` (when !bound), `onServiceConnected` | Buffered playlist |

### JS — `useNativeTTSPlayer.ts`

| Ref | Purpose |
|---|---|
| `chapterAdvancedRef` | Set by `onChapterAdvance`, read by reset effect to skip `bridge.stopPlayback()` |
| `lastAdvancedChapterRef` | Dedupes batched chapter-advance events on WebView resume |
| `advanceTimerRef` | 60 ms coalescing timer: a burst of DISTINCT chapter-advance ids (screen-on flush) navigates only once, to the final id; cancelled by `onDone` and effect teardown |
| `chapterIdRef` | Always synced to `chapterId` prop; read by async callbacks |
| `chapterTitleRef` | Always synced to `chapterTitle` prop |
| `chunksRef`/`chunkRef`/`playingRef` | Mirror of React state for use inside stable callbacks |
| `rateRef`/`pitchRef` | Mirror of rate/pitch state |
| `onEndedRef` | Always synced to current `onEnded` prop |

### JS — `ListenPageClient.tsx`

| Ref | Purpose |
|---|---|
| `autoPlayNextRef` | Set synchronously inside `onEnded` so `setTrack` sees autoplay=true even if URL hasn't updated yet (Capacitor static export URL lag) |
| `nativeInitSyncDoneRef` | One-shot guard: cold-start sync runs at most once per mount |
| `coldStartReplacingRef` | One-shot guard: stale-session guard skips the render in which cold-start sync scheduled a `router.replace` but it hasn't committed yet |
| `settledChapterRef`/`staleChunkRef`/`reportProgressRef` | Progress-reporting machinery |
| `latestRef` | Snapshot of setTrack inputs to avoid stale closures |
| `chapterListScrolledRef` | UX: scroll chapter list to active chapter once |

---

## 2. Mode diagram (Java)

```
                     ┌──── (stopPlayback / stopService)
                     ▼
                  [idle]
                     │ playChunks(ttsReady)
                     ▼
               ┌─[playing]─────────────┐
               │    ▲         │        │
     pause ────┤    │ resume  │        │
               ▼    │         │        │
             [paused]         │        │
                              │        │
               chunk-end──────┤        │
                              │        │
        more chunks in chapter│        │
                              ▼        │
                         speakChunk    │
                                       │
                    chapter-end (all chunks) queue non-empty
                                       │
               ┌──────deliverAutoAdvance────► [playing] (new chapter)
               │                       │
               │  queue empty, fetch possible
               ▼                       │
         [awaitingFetch] ───────────── ┤
            │    ▲                     │
            │    │ mergeQueue / setPendingPlaylist / doPrefetchStep
            │    │ delivers → deliverAutoAdvance → [playing]
            │    │                    │
            │ playlist exhausted      │
            ▼                          │
         fireDone ► [idle] ◀───────────┘
```

Notes:
- `autoAdvancing` is set true only inside `deliverAutoAdvance`'s wrapping of `startChapter` — it suppresses `playFakeSilence` + MediaSession re-assertion at chapter transitions (avoids AudioSession interference).
- `pausedByTransientLoss` forks `[paused]` into two flavors: explicit pause vs. transient audio-focus loss; only the latter auto-resumes on focus gain.

---

## 3. Event flow map

### JS → Java (via `TtsBridge` `@JavascriptInterface` methods — all dispatch to `mainHandler`)

| Method | Callers | Key state mutations |
|---|---|---|
| `startService` | `acquireBackgroundLock` | Ensures service started + bound |
| `stopService` | `releaseBackgroundLock` | stopPlayback + unbind + stopService |
| `playChunksWithId` | `useNativeTTSPlayer.startNativePlayback` | `playChunks` → clear queue, reset flags, speakChunk, kickPrefetch |
| `pausePlayback` | `useNativeTTSPlayer.toggle` | `pauseInternal`; clears `pausedByTransientLoss` |
| `resumePlayback` | `useNativeTTSPlayer.toggle` | `resumePlayback` → isPlaying=true, speakChunk |
| `stopPlayback` | navigateTo, useNativeTTSPlayer reset effect, ListenPageClient stale-session guard, `unmount` | svc.isPlaying=false (WebView thread sync write), then main-thread `stopPlayback` (clears everything, pendingHead=0) |
| `setRate`/`setPitch` | `useNativeTTSPlayer.changeRate/changePitch` | Update on service; engine setters |
| `updateTitle` | `PlayerContext` effect, `useNativeTTSPlayer.startNativePlayback` | currentTitle, notification |
| `getCurrentChunk`/`getCurrentChapterId`/`isPlaying` | multiple (volatile reads) | (read-only) |
| `mergeQueuedChapters` | `ListenPageClient` Effect B | `mergeQueue` → dedupe-add to chapterQueue; deliver if awaitingFetch |
| `queueAllChapters` | (legacy) | `queueAllChapters` → clear + addAll |
| `clearNextChapter` | (legacy) | clearQueue |
| `setPendingChapters` | `ListenPageClient` Effect A | `setPendingPlaylist` → replace playlist, pendingHead=0, prefetchVersion++, kickPrefetch; deliver if awaitingFetch |
| `setSleepTimer`/`cancelSleepTimer` | `useSleepTimer` | Timer runnable |
| `getCompletedChapterIds` | JS progress sync | Drain `completedChapterIds` (+ persists the drained snapshot) |
| `setSessionInfo` | `PlayerContext` effect | bookId keys persistence + server progress PUTs; bookTitle → MediaSession artist + notification subtitle (buffered until bound) |
| `getCurrentTitle`/`getCurrentBookId`/`getTotalChunks` | `PlayerContext` override effect, `BookDetailClient` | (read-only volatile reads) |
| `isOnline` | network-aware code | (read-only) |

### Java → JS (dispatched via `webView.post(() -> webView.evaluateJavascript(...))`)

| Event | Fired when | JS handler | Follow-up |
|---|---|---|---|
| `native-tts-chunk` | `speakChunk` start (utterance onStart) | `useNativeTTSPlayer.onChunk` | setChunkIndex |
| `native-tts-state` | play/pause/stop transitions | `useNativeTTSPlayer.onState` | Sync isPlaying, chunkIndex |
| `native-tts-chapter-advance` | `deliverAutoAdvance` via `dispatchChapterAdvance` | `useNativeTTSPlayer.onChapterAdvance` | chapterAdvancedRef=true; `onEndedRef.current?.(newChId)` → `ListenPageClient.onEnded` → `router.push(…&autoplay=1)` |
| `native-tts-done` | `fireDone` (playlist exhausted, incl. hardware-next on last chapter) | `useNativeTTSPlayer.onDone` | Cancels pending advance-coalesce timer; if no onEnded, release background lock |
| `native-tts-done` + `detail.sleep` | `sleepRunnable` (sleep timer expired) | `useNativeTTSPlayer.onDone` sleep branch | Update playing state ONLY — no onEnded, no chunk reset (resume continues in place) |
| `native-tts-error` | `initTts` failure, language-data missing | `useNativeTTSPlayer.onNativeError` | setTtsError |

### DOM events JS listens to

| Event | Listener file | Purpose |
|---|---|---|
| `visibilitychange` | `ListenPageClient` | If native on different chapter, save progress + `router.replace` to native's current |
| `visibilitychange` | `useNativeTTSPlayer` | Sync `isPlaying` / `chunkIndex` state from bridge |

### Android system callbacks

| Callback | Handler | Purpose |
|---|---|---|
| `AudioFocusChangeListener` | TtsPlaybackService | LOSS → pause + abandon focus + deactivate MediaSession (`sessionWanted=false`); LOSS_TRANSIENT → pauseInternal + set pausedByTransientLoss; GAIN → resume if was transient |
| TTS `UtteranceProgressListener` onStart/onDone | TtsPlaybackService | Dispatch `native-tts-chunk`; advance to next chunk |
| `watchdogRunnable` | TtsPlaybackService | 8s watchdog on TTS engine stall → retry |
| `reassertRunnable` | TtsPlaybackService | 3s periodic MediaSession re-assert (fights TTS engine session-steal) |
| `sleepRunnable` | TtsPlaybackService | Sleep timer fires → pauseInternal |

---

## 4. Navigation entry points

Every path that ends in JS routing to `/listen?chapter=<id>`:

| Entry point | Source | Stops native? | autoplay=1? | Triggers Effect A? | Stale-session guard acts? | Final native state |
|---|---|---|---|---|---|---|
| `navigateTo(chapter, false)` | in-page prev/next, chapter list | YES (immediate `bridge.stopPlayback()`) | no | yes (new chapterId) | no-op (native already stopped) | Fresh playback on new chapter |
| `navigateTo(chapter, true)` | `onEnded` non-native fallback | NO (preserve) | yes | yes | skipped (autoplay=1) | Continues on new chapter |
| `router.push(...&autoplay=1)` from `onChapterAdvance` `onEnded` | `ListenPageClient.setTrack.onEnded` native branch | NO | yes | yes | skipped | Continues (native auto-advanced) |
| `router.replace(...)` from visibilitychange handler | `ListenPageClient` | NO | only if native `isPlaying()` (a paused/restored session must not autoplay) | yes (after commit) | skipped when autoplay; no-op when native paused | Continues on native's chapter, or lands paused |
| `router.replace(...)` from cold-start sync | `ListenPageClient` (once per mount) | NO | only if native `isPlaying()` | yes (after commit) | skipped via `coldStartReplacingRef` (one-render) | Continues on native's chapter, or lands paused (restored session) |
| `<Link href="/listen?…">` from `BookDetailClient` | book detail page | NO | no | yes | **ACTS** (native stopped) | Fresh playback on tapped chapter |
| `<Link>` from `MiniPlayer` | root layout | NO | no | yes | If native on different chapter, acts; if same, no-op | |
| `<Link>` from `ChapterList` | book detail page | NO | no | yes | **ACTS** | Fresh playback |
| `<Link>` from `ReadPageClient` | read page's "listen" button | NO | no | yes | **ACTS** | Fresh playback |
| `<Link>` from `my-books` | my-books page | NO | no | yes | **ACTS if native on different chapter** | Fresh playback |

---

## 5. Invariants

Reference by ID from code comments (`// see I3 in docs/android-player.md`).

**I1.** *(awaitingFetch, Java)* `awaitingFetch ⇒ (chapterQueue.isEmpty() ∨ !isPlaying)`. If the queue has items AND we're playing, we should have delivered immediately. The three awaitingFetch-delivery sites (`mergeQueue`, `setPendingPlaylist`, `doPrefetchStep`) enforce this by calling `deliverAutoAdvance` as soon as a chapter is available AND `isPlaying=true`. When `!isPlaying` (user paused), the item stays queued and resumes via the natural chunk-finish → queue-poll path.

**I2.** *(prefetchActive, Java)* `prefetchActive ⇒ a task is pending on ioExecutor`. If prefetchActive is true but no fetch is running, the chain is silently dead (no further chapters will be queued). `prefetchVersion++` is the ONLY sanctioned way to invalidate an in-flight fetch; each bump must be paired with `prefetchActive=false` or a fresh `kickPrefetch`.

**I3.** *(autoAdvancing, Java)* `autoAdvancing=true` only inside `deliverAutoAdvance`'s call to `startChapter`. It suppresses `playFakeSilence` + MediaSession reassertion to avoid AudioSession interference at chapter boundaries. Must never be true when `startChapter` is called for user-initiated playback (`playChunks` calls `speakChunk` directly, not through `deliverAutoAdvance`).

**I4.** *(Lockscreen-resume, JS)* When `visibilitychange` / cold-start sync returns JS to the same chapter native is playing, the reset effect in `useNativeTTSPlayer` MUST NOT call `bridge.stopPlayback()`. Otherwise the subsequent autoPlay re-entry replays from chunk 0 — the lockscreen-resume bug. Current implementation: `nativeAlreadyPlaying` branch.

**I5.** *(Cascade-catches-up, JS)* When native is playing a chapter AHEAD of JS (multi-chapter screen-off advance race), the reset effect MUST NOT call `bridge.stopPlayback()`. The queued `native-tts-chapter-advance` events will fire and sync JS forward. Current implementation: `nativeIsAhead` branch.

**I6.** *(Stale-session, JS)* When a user navigates into `/listen` via a non-autoplay path (a `<Link>`) while native is playing a different chapter from a pre-existing session, JS must stop native before its next auto-advance fires. Current implementation: `ListenPageClient` stale-session guard effect gated on `!autoPlay`.

**I7.** *(pendingHead sanity, Java)* `pendingHead ≤ pendingPlaylist.size()` always. After `chapterQueue.clear()` (either via `playChunks` or `stopPlayback`), `pendingHead` must be re-scanned — otherwise the skip-loop leaves it stale at a forward offset, causing `doPrefetchStep` to fetch chapter `pendingPlaylist[pendingHead]` instead of the next un-queued chapter. Current implementation: `rescanPendingHead()` at top of `doPrefetchStep`, and FAILSAFE in `onChunkFinished`.

---

## 6. Durable session persistence & background progress sync

Added 2026-06-10 ("seamless background + constant sync").

**Snapshot.** `persistSession()` writes one JSON blob to SharedPreferences
(`tts_session/session`): bookId, bookTitle, chapterId, title, chunkIdx,
rate/pitch, playing flag, apiBase, coverUrl, ts, the next ≤50 upcoming
playlist entries (strictly after the current chapter), and the undrained
`completedChapterIds`. The auth TOKEN is deliberately NOT persisted (no JWT at
rest) — the text endpoint is public so restore/auto-resume work without it, and
server progress PUTs stay paused until JS re-seeds the token (Effect A).
Written on every chunk start, chapter transition, pause, done, playlist update,
and `setSessionInfo`; cleared ONLY by `stopPlayback()` (user stop / swipe-away
/ logout / stale-session guard). Always written on the main thread —
`getAndClearCompletedChapterIds` (JS thread) posts to main.

**Restore.** `onCreate → restoreSession()` loads the snapshot as a PAUSED
session: bridge getters immediately report the true last position, so JS
cold-start sync, BookDetail "continue listening" (`getCurrentBookId` match →
`getCurrentChapterId`), and the notification Play button all land where
playback actually stopped — even after a process kill during a screen-off
session. Chunk text is NOT persisted; `resumeFromRestoredSession()` re-fetches
it (urgent self-fetch) and `startChapter`s at the saved index. Its async
callback aborts if `currentChunks != null`, the chapter changed, or the user
paused meanwhile.

**Auto-resume.** `onStartCommand` with `intent == null` (only the START_STICKY
system restart path — every app-initiated start carries an intent) auto-resumes
when the snapshot says `playing=true` and is fresher than 2 minutes: an OS kill
mid-listen recovers as an uninterrupted session. Older snapshots stay paused.

**Last-position pointer.** `persistSession()` also writes a second prefs key
`last_position` ({bookId, chapterId, chunkIdx, ts}) that — unlike the session
snapshot — SURVIVES `stopPlayback()` (swipe-away, explicit stop). It can never
resume a zombie service; it only tells the UI where listening last stood.
`TtsBridge.getLastListenPosition()` reads it straight from SharedPreferences so
it works before the service binds. BookDetail honors it only when its ts beats
the device's `listen-chapter-ts:` localStorage pointer (a later /listen visit
without playing must still win).

**App-open reconciler (JS).** A cold start always lands on the home page, so
`PlayerContext` runs a reconciler on mount (+800 ms/3 s retries for service
bind/restore lag) and on every visibilitychange: reads the live bridge session
(or `last_position` fallback) → refreshes `listen-chapter[-ts]:` localStorage,
`saveLocalProgress`/`saveLocalBookProgress`, pushes `syncBookProgressToServer`
(Java's own PUTs die with the token on process kill), and drains
`getCompletedChapterIds()` for XP. ALL XP drains (here and ListenPageClient)
are gated on the chapter list being loaded: XP = max(10, words/50)·1.5 and the
backend dedupes the FIRST submission, so draining with word_count 0 would
permanently under-award. The trackless `nativeChapterOverride` (with
bookId/bookTitle/coverUrl) also lets MiniPlayer render and control a session
the WebView never set a track for; `toggle()`'s resume branch therefore must
not require JS chunks (`getCurrentChunk() >= 0 → resumePlayback()` first).

**Server sync.** `maybeSyncProgressToServer()` PUTs `/api/progress`
(book_id, chapter_id, progress_value=chunkIdx, total_value=chunk count) with the
stored bearer token — throttled to 30 s, forced at chapter boundaries / pause /
done. This keeps the server row fresh during hours of screen-off playback, so
cross-device resume and post-kill cold starts (`listenProgress` query) are
accurate. Skipped when bookId/apiBase/token are missing (logged out). JS remains
a second writer (debounced `saveProgress`) — both upsert the same per-book row.

---

## 7. Known bug history

See `memory/project_tts_state_machine.md` for detail. Summary:

- **Stuck `awaitingFetch` (fixed 2026-04-10)** — `mergeQueue` / `setPendingPlaylist` now deliver on populated queue.
- **Stale-session 46-chapter jump (fixed 2026-04-24)** — `ListenPageClient` stale-session guard.
- **Paused auto-resume (fixed 2026-04-24)** — awaitingFetch branches gate on `isPlaying` (I2).
- **50-chapter seekChunk jump (fixed 2026-04-24)** — `rescanPendingHead()` when queue cleared (I8).
