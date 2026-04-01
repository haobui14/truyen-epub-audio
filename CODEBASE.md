# TruyệnAudio — Codebase Reference

> **Purpose**: Quick-reference guide for every significant component, hook, lib, and service. Explains data flow, offline/online mode handling, and the XP/leveling system in depth.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Frontend Pages](#2-frontend-pages)
3. [Player System](#3-player-system)
4. [Hooks](#4-hooks)
5. [Lib (Utilities & Services)](#5-lib-utilities--services)
6. [Android/Java Layer (Capacitor)](#6-androidjava-layer-capacitor)
7. [Backend Routers](#7-backend-routers)
8. [Offline / Online Mode — Deep Dive](#8-offline--online-mode--deep-dive)
9. [XP & Leveling System — Deep Dive](#9-xp--leveling-system--deep-dive)
10. [Data Flow Diagrams](#10-data-flow-diagrams)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Next.js Frontend (Vercel static export / Capacitor APK)     │
│                                                              │
│  Pages → PlayerContext → useSpeechPlayer / useNativeTTS     │
│                       ↓ (native only)                        │
│  WebView ←→ TtsBridge (JavascriptInterface) ←→ TtsService   │
│                                                              │
│  IndexedDB (offline text, progress, chapters, books)         │
│  Cache API (offline audio MP3s for web-TTS voice)            │
└──────────────────────────────────────────────────────────────┘
                          ↕  REST API
┌──────────────────────────────────────────────────────────────┐
│  FastAPI Backend (Railway)                                   │
│  Supabase PostgreSQL                                         │
└──────────────────────────────────────────────────────────────┘
```

**Two TTS engines run side‑by‑side** — only one is active at a time:

| Engine | Voice prefix | Where it runs | Offline? |
|--------|-------------|---------------|----------|
| Web TTS (backend Azure) | `vi-VN-HoaiMyNeural`, `vi-VN-NamMinhNeural`, `gtts` | Backend → MP3 stream | Only if audio cached in Cache API |
| Native TTS | `native:vi-VN-default` | Android `TextToSpeech` engine | Always (device TTS is offline) |

---

## 2. Frontend Pages

### `app/providers.tsx` — App Bootstrap

Wraps the entire app tree. Runs once on mount:

1. **Native hydration** — calls `hydrateAuthFromNative()` to copy tokens from Android `SharedPreferences` → `localStorage`, then dispatches `auth-change` and invalidates React Query.
2. **Token refresh** — calls `tryRefreshToken()` proactively. If it fails (expired / no network), leaves auth alone rather than logging the user out.
3. **Profile sync** — if the token is fresh, calls `api.getMe()` and updates the stored `AuthUser` with the latest `role`, `display_name`, and `avatar_base64` from the server. This is the only automatic sync path; the profile page handles updates interactively.
4. **Visibility listeners** — on every screen-on, re-runs token refresh + query invalidation.
5. **45-minute token rotation** — `setInterval` proactively rotates the access token before expiry.
6. **Progress flush** — flushes the offline progress queue on mount and whenever `online` fires.

Also renders `NativeUrlRestorer` — saves the current URL to `localStorage` on every route change, restores it after Android process-death (detected via `sessionStorage` being empty on cold start).

### `app/page.tsx` — Home / Library

- Fetches all books from `/api/books` with `getCachedBooks()` as offline fallback.
- If logged in, fetches `api.getMyBooks()` (sorted by `updated_at desc`) and shows a **"Tiếp tục đọc"** horizontal scroll row.
- Each `RecentCard` shows cover, progress bar, and a **"✓ Đọc xong"** badge if `chapter_index + 1 >= book.total_chapters`.
- Featured book shown via `SpotlightCard`.
- Genre filter row uses `BookScrollRow`.

### `app/books/[bookId]/BookDetailClient.tsx` — Book Detail

- Shows book metadata, chapter list, read/listen resume buttons.
- **Download for Offline** button (`handleDownloadBook`):
  1. Caches book metadata (`cacheBook`).
  2. Fetches and caches cover as base64 data URL (`cacheCover`).
  3. Paginates through all chapters, caches each page (`cacheChapters`).
  4. Writes flat all-chapters snapshot (`cacheAllChapters` with key `${bookId}:all`).
  5. For every chapter: checks `isChapterTextCached(ch.id)` — if missing, calls `api.getChapterText` and writes to IndexedDB.
  6. Shows a progress indicator `{ done, total }` during the download.
- Resume button: prefers `localStorage.getItem("listen-chapter:${bookId}")` for audio position, falls back to DB progress.

### `app/books/[bookId]/listen/ListenPageClient.tsx` — Player / Listen Page

The most complex page (~700 lines). Key responsibilities:

| What | How |
|------|-----|
| Load chapter text | React Query; on native checks IndexedDB first |
| Load chapter list | React Query; offline falls back to `getCachedAllChapters` |
| Save progress | `useProgressSync` debounced every 5 s; also `saveLocalBookProgress` on chapter change |
| Award XP (chunk-based) | When `chunkIndex / totalChunks >= 0.8` |
| Award XP (native auto-advance) | `native-tts-chapter-advance` event carries `completedChapterId` |
| Award XP (screen-off safety net) | `visibilitychange` → `bridge.getCompletedChapterIds()` |
| Queue native chapters | Async effect builds up to 10 queued chapters |
| Navigate on native advance | `router.replace` (not push — avoids history pollution) |
| Sync JS on screen-on | `handleVisibilityChange` reads `bridge.getCurrentChapterId()` |
| Cold-start sync | `nativeInitSyncDoneRef` runs once when `allChapters` loads |

**Queue effect logic** (native only, runs whenever `chapterId` changes):
1. Guard: if `wasAutoAdvanceRef.current` is true, the native queue is already valid — skip.
2. Gather up to 10 chapters after `currentIndex` (by `chapter_index`).
3. **Phase 1**: For each, check React Query cache then IndexedDB. Collect all hits.
4. Call `bridge.mergeQueuedChapters(initialQueue)` — sends available chapters immediately.
5. **Phase 2**: Fetch remaining from API one-by-one. On each success, call `bridge.mergeQueuedChapters(growingQueue)`.
6. **Safety-net final call**: ensures last incremental update wasn't skipped.
7. `mergeQueuedChapters` (not `queueAllChapters`) is used throughout — it skips the currently-playing chapter so the queue is safely replenished on every chapter change without re-queuing in-flight chapters.

### `app/books/[bookId]/read/ReadPageClient.tsx` — Reading Page

- Text reader with font size controls and chapter navigation.
- Uses `useProgressSync` to save scroll progress.
- Embeds `useReadingXp` hook to award XP for genuine reading (see §9).

### `app/profile/page.tsx` — User Profile

- Redirects to `/login` if not authenticated.
- User object is held in **reactive `useState`** initialised from `getUser()`, then kept in sync via an `auth-change` event listener (same pattern as `BottomNav.tsx`). This is required on Android because the Capacitor build uses `output: "export"` — `router.refresh()` is a no-op in a static export, so state must be updated directly.
- Calls `api.getMyStats()` → renders:
  - **SVG level ring** — circular progress arc colored by realm tier.
  - **XP bar** — progress within current level.
  - **4-stat grid**: chapters read, chapters listened, total EXP, books in progress.
  - **"Cách nhận EXP" info box** — explains earning rules to user.
  - **Realm progression table** — all 24 levels with lock/active/completed state.
- **Edit profile** (pencil button overlay on avatar corner):
  - Opens an in-page modal with avatar picker + display name text input.
  - `handleImagePick` — reads the picked image file, resizes it to max 400×400 via `<canvas>` at 0.75 JPEG quality before base64 encoding (keeps payload under ~100 KB).
  - `handleSave` — calls `api.updateProfile()`, then `setAuth()` with the merged user object. `setAuth` writes to localStorage + Android SharedPreferences and dispatches `auth-change`, which the reactive listener picks up to update the displayed user immediately — no navigation needed.
  - Avatar display: renders the `avatar_base64` `<img>` if set; otherwise falls back to 2-letter initials in the level colour.
  - Name display: shows `display_name` if set, with `email` shown as a subtitle line below it.

### `app/login/` — Auth Pages

Standard email/password login and register. Stores JWT + refresh token via `setAuth`.

### `app/my-books/` — My Books

Lists books the user has interacted with (from `api.getMyBooks()`).

### `app/search/` — Search

Full-text search over the book catalogue.

### `app/admin/` — Admin Pages

CRUD for books, chapters, editing chapter text. Guarded by `user.role === "admin"`.

---

## 3. Player System

### `context/PlayerContext.tsx` — Global Player State

Single source of truth for the player. Lives in the root `layout.tsx` so it survives route changes.

```
ListenPageClient.setTrack(PlayerTrack) 
    → PlayerContext 
        → useSpeechPlayer     (web TTS, if voice is backend)
        → useNativeTTSPlayer  (native TTS, if voice starts with "native:")
```

**`PlayerTrack` fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `bookId / chapterId` | string | Identifies current position |
| `chapter / book` | objects | Metadata for display |
| `text` | string \| null | Chapter text; null while loading |
| `isLoadingText` | boolean | Shows buffering spinner |
| `onPrev / onNext` | callbacks | Navigate to adjacent chapter |
| `onEnded` | `(nativeChapterId?) => void` | Called when chapter finishes |
| `neighborChapters` | `{id}[]` | ±2 chapters for audio preload |
| `initialChunkIndex` | number | Resume position (from saved progress) |
| `autoPlay` | boolean | Start playing immediately |

**`onEnded` has two paths:**
- `nativeChapterId` provided → native auto-advance (queue had next chapter); use `router.replace` and set `wasAutoAdvanceRef = true`.
- No `nativeChapterId` → web TTS ended or native queue exhausted; use `navigateTo(nextChapter, true)` which calls `router.push`.

**Voice switching**: switching between backend ↔ native voices stops current playback first (both engines mustn't fight). Switching between two backend voices just restarts the current chunk.

**PlayerContext values exposed:**

| Value | Source |
|-------|--------|
| `isPlaying, isBuffering, chunkIndex, totalChunks` | active player hook |
| `rate, pitch` | shared, stored in `localStorage` |
| `voice, setVoice` | stored in `localStorage` |
| `cacheStatuses` | `useChapterAudioPreload` |
| `nativeTtsError` | `useNativeTTSPlayer` |
| `sleepRemaining, setSleepTimer, cancelSleepTimer` | `useSleepTimer` |

---

## 4. Hooks

### `hooks/useNativeTTSPlayer.ts`

Connects WebView events from the Java `TtsPlaybackService` to React state.

**Events listened (on `window`):**

| Event | Payload | Action |
|-------|---------|--------|
| `native-tts-chunk` | `{index}` | Update `chunkIndex`; ignore if native is on a different chapter |
| `native-tts-chapter-advance` | `{completedChapterId, newChapterId}` | Set `chapterAdvancedRef`, navigate via `onEnded(newChapterId)` |
| `native-tts-done` | none | Player stopped; call `onEnded()` only if not already advanced |
| `native-tts-state` | `{playing, index}` | Sync playing/chunk state; ignore if wrong chapter |
| `native-tts-error` | `{message}` | Show error UI |

**`chapterAdvancedRef`** — prevents the chapter-reset effect from calling `bridge.stopPlayback()` when native already advanced on its own.

**`lastAdvancedChapterRef`** — deduplicates batched `native-tts-chapter-advance` events that all fire at once when the WebView resumes from screen-off. Without this, 10 queued events would trigger 10 `router.replace` calls.

**Reset effect** (runs on `chapterId` / `text` change):
- If `wasAutoAdvanced` AND native is already playing this chapter → sync JS state from bridge; skip `stopPlayback`.
- If native is already on this chapter and playing → sync state; skip `startNativePlayback`.
- Otherwise → `bridge.stopPlayback()` then `startNativePlayback(startIdx)`.

**`syncState` (visibilitychange)** — on screen-on, reads `bridge.getCurrentChapterId()`. If it matches, syncs chunk index and playing state. If it doesn't match, does nothing — the `handleVisibilityChange` in `ListenPageClient` handles navigation.

### `hooks/useSpeechPlayer.ts`

Drives web TTS audio via backend API. Each chunk is a separate POST to `/api/tts/speak` returning an MP3 blob URL. Supports Cache API for offline playback.

- **`prefetchNextChapterAudio`** — exported helper; pre-fetches first 3 chunks of the next chapter while current chapter is near end. Stored in `crossChapterCache` which persists across chapter resets.
- **Retry logic**: retries indefinitely on network errors and 5xx. 20 s per-request timeout. Does not retry on 4xx.
- **Offline handling**: `waitForOnline()` suspends the fetch loop until `navigator.onLine` becomes true.

### `hooks/useProgressSync.ts`

Debounced progress saving (5 s default). On each flush:
1. `saveLocalProgress` (chapter-level, IndexedDB).
2. `saveLocalBookProgress` (book-level, advances only — never goes backward).
3. Checks `isLatestChapterForBook` before writing to server — skips if native TTS moved ahead.
4. Calls `api.saveProgress` → falls back to `enqueueProgress` on network error.
5. Progress queue is flushed by `Providers` on app start and on `online` event.

### `hooks/useChapterAudioPreload.ts`

Silently downloads full chapter MP3 from `/api/tts/chapter-audio/{id}` into the **Cache API** (`chapter-audio-v2`). Only used for **web/backend voices** — native TTS generates audio on-device, no download needed. Waits for `online` event if offline. Deduplicates via a module-level `inFlight` Set.

### `hooks/useSleepTimer.ts`

Sleep timer backed by an **absolute expiry timestamp** (not a countdown). Uses `visibilitychange` to recalculate remaining seconds on screen-on (setTimeout is throttled when screen is off). Notifies the Java service via `bridge.setSleepTimer(expireAtMs)` so the service can stop playback entirely in Java even when JS is fully suspended.

### `hooks/useDarkMode.ts`

Reads/writes dark mode preference in `localStorage`. Applies `dark` class to `<html>`.

### `hooks/useNativeTTSVoices` / `useNativeTTSAvailable`

Utility hooks. `useNativeTTSAvailable` uses `useState` (not `useMemo`) to avoid SSR hydration mismatch when detecting `isNativePlatform()`.

---

## 5. Lib (Utilities & Services)

### `lib/api.ts`

All backend API calls. Key points:
- Auto-attaches `Authorization: Bearer <token>` header.
- On 401, calls `tryRefreshToken()` once and retries. On confirmed invalid token → `clearAuth()`. On network error → leaves auth alone.
- `tryRefreshToken` is de-duplicated (single concurrent attempt via `refreshPromise`). On success, merges `display_name` and `avatar_base64` from the refresh response back into the stored user.
- `api.completeChapter({ chapter_id, book_id, mode, word_count })` — awards XP.
- `api.getMyStats()` — returns `UserStats`.
- `api.getMyBooks()` — returns books sorted by `updated_at desc`.
- `api.updateProfile({ display_name?, avatar_base64? })` — `PATCH /api/auth/update-profile`.

### `lib/auth.ts`

JWT-based auth stored in `localStorage`. `hydrateAuthFromNative()` copies tokens from Android `SharedPreferences` (written by Capacitor plugins) into `localStorage` on app start.

**`AuthUser` interface fields:**

| Field | Type | Notes |
|-------|------|-------|
| `user_id` | `string` | UUID |
| `email` | `string` | Always present |
| `role` | `string?` | `"admin"` or `"user"` |
| `display_name` | `string?` | Optional nickname set by user |
| `avatar_base64` | `string?` | JPEG base64 data URL, max ~100 KB |

`setAuth(token, user, refreshToken?)` — writes all three to `localStorage`, persists to Android `SharedPreferences`, and dispatches `"auth-change"` event so any component listening (profile page, BottomNav, HeaderAuth) re-reads and re-renders immediately.

### `lib/backgroundLock.ts`

Wraps Capacitor's `KeepAwake` plugin and the `TtsBridge` JavascriptInterface.
- `acquireBackgroundLock()` — calls `bridge.startService()` + `KeepAwake.keepAwake()`.
- `releaseBackgroundLock()` — calls `bridge.stopService()` + `KeepAwake.allowSleep()`.
- `getTtsBridge()` — returns `window.TtsBridge` typed as `TtsBridgeNative`.

**`TtsBridgeNative` interface** (all methods sync, run on WebView thread, bridge dispatches to main thread internally):

| Method | Purpose |
|--------|---------|
| `playChunksWithId(chunksJson, rate, pitch, startIdx, title, chapterId)` | Start playing |
| `pausePlayback() / resumePlayback() / stopPlayback()` | Transport control |
| `queueAllChapters(chaptersJson)` | Replace entire queue (initial load via `playChunks`) |
| `mergeQueuedChapters(chaptersJson)` | Safe incremental queue rebuild — never re-queues the playing chapter |
| `getCurrentChapterId()` | Volatile read — safe from JS thread |
| `getCurrentChunk()` | Current chunk index |
| `isPlaying()` | Boolean state |
| `getCompletedChapterIds()` | Drain screen-off completed chapter list (XP recovery) |
| `setSleepTimer(expireAtMs) / cancelSleepTimer()` | Native sleep timer |

### `lib/offlineDB.ts`

Opens the shared IndexedDB database `truyen-audio-offline` (version 5). Object stores:

| Store | Key | Contents |
|-------|-----|----------|
| `chapter-text` | chapter ID | `{id, text_content, cached_at}` |
| `progress-queue` | `${bookId}:${chapterId}` | Offline sync queue |
| `progress-store` | `${bookId}:${chapterId}` | Persistent local progress |
| `my-books-cache` | `"latest"` | Cached `/api/progress/my-books` response |
| `books-list` | `"all"` | Cached books array |
| `book-detail` | book ID | Cached book object |
| `book-chapters` | `${bookId}:${page}` or `${bookId}:all` | Cached chapter lists |
| `book-covers` | book ID | Base64 data URL of cover image |

### `lib/chapterTextCache.ts`

CRUD helpers for the `chapter-text` store. `getAllCachedChapterIds()` returns all chapter IDs for the offline badge indicator in `ListenPageClient`.

### `lib/bookCache.ts`

CRUD helpers for `books-list`, `book-detail`, `book-chapters`, and `book-covers`. `cacheAllChapters` writes the `${bookId}:all` snapshot used offline.

### `lib/progressQueue.ts`

Manages the offline progress queue and the persistent local progress store. Key functions:
- `enqueueProgress` — saves to `progress-queue` for later server sync.
- `flushProgressQueue` — iterates all queue entries and calls `api.saveProgress`; removes entries on success.
- `saveLocalBookProgress` — advances book-level position (only if `chapter_index` is higher than stored).
- `isLatestChapterForBook` — checks if a chapter ID is the most recently saved for a book.

### `lib/textChunks.ts`

`splitIntoChunks(text, targetCount=20, hardMaxLen=4000)` — splits chapter text at sentence boundaries into ~20 chunks. Each chunk = 5% progress. The 4000-char hard cap prevents TTS engine instability on very long sentences.

### `lib/audioFileCache.ts`

Cache API (`chapter-audio-v2`) helpers for full-chapter MP3 blobs. Used only for web/backend TTS voices. Keys are `chapter-audio://${chapterId}/${voice}`.

### `lib/xianxia.ts`

The 24-level cultivation system. See §9 for full details.

### `lib/capacitor.ts`

Tiny wrappers: `isNativePlatform()` and `getPlatform()`.

### `lib/constants.ts`

`API_URL` — reads `NEXT_PUBLIC_API_URL` env var, defaults to `http://localhost:8000`.

---

## 6. Android/Java Layer (Capacitor)

### `TtsBridge.java`

`@JavascriptInterface` class exposed as `window.TtsBridge` in the WebView. Every method dispatches its body to the main thread via `mainHandler.post` before touching Android APIs.

Maintains a `ServiceConnection` to `TtsPlaybackService`. If `playChunksWithId` is called before `onServiceConnected` fires (slow bind), arguments are saved as `pendingChunks` and replayed in `onServiceConnected`.

### `TtsPlaybackService.java`

Android `Service` (foreground) that drives `TextToSpeech`. Survives screen-off because it is a foreground service (shows persistent notification).

**Key state (volatile for cross-thread reads):**

| Field | Type | Purpose |
|-------|------|---------|
| `currentChapterId` | `volatile String` | Current chapter being spoken |
| `currentChunkIdx` | `volatile int` | Index within current chunk array |
| `isPlaying` | `volatile boolean` | Playback/pause state |
| `playGeneration` | `int` | Incremented on every new chapter/chunk start; stale callbacks check this |

**Chapter queue** (`LinkedList<ChapterItem>`) holds pre-loaded upcoming chapters for seamless auto-advance without JS involvement.

**`mergeQueue(chapters)`** — rebuilds the queue from the new list, skipping `currentChapterId` (the chapter currently being spoken) and any duplicates. Uses a `HashSet<String>` seeded with `currentChapterId`. Safe because both `mergeQueue` and `onChunkFinished` always run on the main thread, so they are fully serialized.

**`onChunkFinished(idx)`** flow:
```
Next chunk exists in this chapter?
  → speakChunk(idx + 1)
Chapter finished, queue has next chapter?
  → capture completedId + newChapterId BEFORE startChapter() mutates currentChapterId
  → add completedId to completedChapterIds list (synchronized)
  → dispatch "native-tts-chapter-advance" CustomEvent with both IDs
  → startChapter(nextChapter, 0)
Queue exhausted?
  → dispatch "native-tts-done"
  → dispatch "native-tts-state" {playing: false}
  → abandonAudioFocus()
```

**`playGeneration` race protection**: every `UtteranceProgressListener` lambda captures `generation = playGeneration` at creation time. The `mainHandler.post` callback bails if `gen != playGeneration` — prevents stale utterance callbacks from an old chapter arriving after stop+start.

**`getAndClearCompletedChapterIds()`** — thread-safe (`synchronized`) read-and-clear of the `completedChapterIds` list. Called by JS on screen-on to recover XP for chapters completed during screen-off.

**Silent MediaPlayer trick**: Before each TTS chunk, a `MediaPlayer` plays `R.raw.silence` at volume 0. This makes Android treat our `MediaSessionCompat` as the active media session, preventing the TTS engine's internal session from stealing earbud/BT button routing.

**`TtsPlaybackService` public API** (called by `TtsBridge` always on main thread):

```
playChunks(chunks, rate, pitch, startIdx, title, chapterId)
pausePlayback()
resumePlayback()
stopPlayback()
queueAllChapters(List<ChapterItem>)   ← replaces queue with clear()+addAll()
mergeQueue(List<ChapterItem>)         ← safe incremental update, skips currentChapterId
clearQueue()
setSleepTimer(long expireAtMs)
cancelSleepTimer()
getAndClearCompletedChapterIds()
```

---

## 7. Backend Routers

### `routers/stats.py` — XP / Leveling

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stats/complete-chapter` | POST | Award XP for a chapter+mode. Idempotent (unique constraint on user+chapter+mode). XP formula: `max(10, ceil(word_count / 50))` for read; `× 1.5` for listen. Updates `user_stats` aggregate row (upsert). |
| `/api/stats/me` | GET | Return the caller's `user_stats` row. |

### `routers/books.py`

CRUD for books. Includes `GET /api/books/my-books` which returns books for the current user sorted by `updated_at desc`.

### `routers/chapters.py`

CRUD for chapters. Includes `GET /api/chapters/{id}/text` returning `text_content`.

### `routers/auth.py`

Login, register, refresh token, get-me, update-profile.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/signup` | POST | Create account; returns `AuthResponse` |
| `/api/auth/login` | POST | Verify password; returns `AuthResponse` |
| `/api/auth/refresh` | POST | Rotate refresh token; returns `AuthResponse` |
| `/api/auth/me` | GET | Return current user including `display_name` + `avatar_base64` |
| `/api/auth/update-profile` | PATCH | Update `display_name` and/or `avatar_base64`. Rejects `avatar_base64` strings > 500 KB. Returns `{display_name, avatar_base64}`. |

`AuthResponse` includes `display_name` and `avatar_base64` so fresh profile data is available immediately after login/refresh without a separate `getMe()` call.

**DB columns** (`users` table):
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_base64 TEXT;
```

### `routers/tts.py`

- `POST /api/tts/speak` — synthesize a text chunk.
- `GET /api/tts/chapter-audio/{id}` — return full chapter MP3 for offline caching.

### `routers/progress.py`

Save and retrieve per-user progress rows.

---

## 8. Offline / Online Mode — Deep Dive

### Storage Layers (priority order on read)

```
1. React Query in-memory cache  (fastest, lost on reload)
2. IndexedDB (chapter-text, book metadata, chapter lists)
3. Cache API (chapter MP3 audio — web voice only)
4. Backend API (requires network)
```

### What Works Fully Offline

✅ Browsing book list and details (if previously visited online)  
✅ **Native TTS listening** for all downloaded chapters (device generates audio — no network)  
✅ Reading chapter text for downloaded chapters  
✅ Progress saving (written to IndexedDB; synced to server when online)  
✅ XP display / level ring (reads from server on load; no offline fallback needed since it's cosmetic)

❌ Web TTS listening unless audio was pre-downloaded into Cache API  
❌ Loading books/chapters not previously visited

### Download Flow (`handleDownloadBook`)

```
User taps "Tải truyện offline"
  → Cache book metadata (IndexedDB book-detail)
  → Fetch cover → base64 data URL → cache (IndexedDB book-covers)
  → For each chapter page: api.getBookChapters → cacheChapters(bookId, page)
  → Write flat snapshot: cacheAllChapters(bookId, {all chapters})
  → For each chapter:
       isChapterTextCached? skip : api.getChapterText → cacheChapterText
  → Update progress indicator {done, total}
  → setDlDone(true)
```

The flat `${bookId}:all` snapshot is critical — the listen page queries this key directly for its chapter list. Without it, the listen page would need to stitch paginated caches at runtime.

### Queue Building Offline

`ListenPageClient` queue effect runs even offline. For each of the next 10 chapters:
1. Check React Query cache (text might already be loaded in memory).
2. Check IndexedDB (`getCachedChapterText`).
3. If both miss, try `api.getChapterText` — **this fails immediately on Android when offline**, and is silently caught.

Result: only chapters whose text is in cache get queued. When the queue empties, native fires `native-tts-done` and JS navigates to the next chapter. If that chapter's text is also cached, it starts playing. If not, the page shows "loading" until either the text loads from IndexedDB or a network connection is available.

### Progress Sync (Offline)

```
Chunk advances → useProgressSync.reportProgress(chunkIndex, totalChunks)
  → debounce 5s
  → saveLocalProgress (IndexedDB progress-store)  ← always, even offline
  → saveLocalBookProgress                          ← always, even offline
  → api.saveProgress                               → on fail: enqueueProgress
                                                              (progress-queue)

App comes back online:
  Providers: window.addEventListener("online", → flushProgressQueue())
  Also: flushProgressQueue() on every app start in Providers.useEffect
```

### Screen-Off Behavior (Native)

When the Android screen turns off:
- The WebView is suspended by the OS — JS events stop firing.
- `TtsPlaybackService` continues running as a foreground service; TTS plays uninterrupted.
- Native auto-advances chapters by polling its own `chapterQueue`.
- Each completed chapter is added to `completedChapterIds` (Java synchronized list).
- When the screen turns on (WebView resumes):
  1. Queued `evaluateJavascript` calls flush — batched `native-tts-chapter-advance` events fire all at once.
  2. `lastAdvancedChapterRef` deduplication prevents multiple `router.replace` calls for the same chapter.
  3. `handleVisibilityChange` in `ListenPageClient` reads `bridge.getCurrentChapterId()` and navigates to the correct chapter regardless of how many chapters played.
  4. `visibilitychange` XP safety net: calls `bridge.getCompletedChapterIds()`, drains and awards XP for all chapters completed during screen-off.

### Token Refresh on Resume

`Providers` listens to `visibilitychange`. On each screen-on:
1. Calls `tryRefreshToken()`.
2. On success, invalidates all React Query caches so stale data is re-fetched.
3. Flushes the offline progress queue.

---

## 9. XP & Leveling System — Deep Dive

### EXP Formula

Backend (`routers/stats.py`):
```python
base_exp  = max(10, ceil(word_count / 50))   # minimum 10 EXP per chapter
exp_read  = base_exp                           # reading
exp_listen = int(base_exp * 1.5)              # listening (50% bonus)
```

Example: a 2 000-word chapter → 40 EXP reading / 60 EXP listening.

### Idempotency

`user_chapter_completions` has a **UNIQUE constraint** on `(user_id, chapter_id, mode)`. The backend checks for an existing row before inserting and returns `{already_completed: true, exp_earned: 0}` if found. The frontend also maintains a **session-scoped `Set`** (`listenXpCompletedRef`, `completedRef`in `useReadingXp`) to avoid even sending duplicate requests within a single session.

### Reading XP (`useReadingXp` in `ReadPageClient`)

Tracks **genuine reading** — not just loading the chapter:

**Conditions to award:**
1. User has been on the page for `threshold` seconds of **visible, active time** (tab not hidden).
2. User has scrolled past **25%** of the page.

```
threshold = clamp(15, 90, round(wordCount / 300 * 60 * 0.35))
```
This is approximately 35% of the expected reading time at 300 words/minute. Capped at 90 s so very long chapters aren't punishing.

**Time tracking:**
- `setInterval(tick, 2000)` accumulates delta since `lastVisibleRef` on each tick.
- `document.hidden` check pauses the timer when the tab is hidden.
- `visibilitychange` listener resets `lastVisibleRef` to `null` on hide and resumes on show.

### Listening XP — 3 Award Paths (priority order)

#### Path 1: Chunk-based (80% threshold)
```
useEffect([chunkIndex, totalChunks]) in ListenPageClient
  if chunkIndex / totalChunks >= 0.8:
    if !listenXpCompletedRef.has(chapterId):
      api.completeChapter({..., mode: "listen"})
      listenXpCompletedRef.add(chapterId)
```
This fires when the user is actively listening with the screen on and the WebView is receiving `native-tts-chunk` events.

#### Path 2: Native auto-advance event
```
window.addEventListener("native-tts-chapter-advance", onAdvance)
  const completedId = event.detail.completedChapterId
  if !listenXpCompletedRef.has(completedId):
    api.completeChapter({chapter_id: completedId, ..., mode: "listen"})
    listenXpCompletedRef.add(completedId)
```
Covers the transition chapter when native advances. Fires for every batched event on screen-on, but the `Set` guard ensures only one API call per chapter.

#### Path 3: Screen-on safety net (screen-off XP recovery)
```
document.addEventListener("visibilitychange", onVisible)
  if document.hidden: return
  ids = JSON.parse(bridge.getCompletedChapterIds())  ← drains Java list
  for id in ids:
    if !listenXpCompletedRef.has(id):
      api.completeChapter(...)
      listenXpCompletedRef.add(id)
```
`bridge.getCompletedChapterIds()` calls `TtsPlaybackService.getAndClearCompletedChapterIds()` which returns and atomically clears the Java-side list. Called once per screen-on; the Java list is drained on read to prevent double-awarding.

**Why three paths?** The WebView can be in three states:
- **Screen on, active**: Path 1 fires naturally as chunks progress.
- **Screen on, chapter just finished**: Path 2 fires from the queued event.
- **Screen was off, deep suspend**: evaluateJavascript calls may have been dropped entirely; Path 3 calls directly into Java to recover.

### Level Table (`lib/xianxia.ts`)

24 levels mapped to traditional Xianxia cultivation realms:

| Levels | Realm | Color |
|--------|-------|-------|
| 1–7 | Luyện Khí | `#94a3b8` (slate) |
| 8–10 | Trúc Cơ | `#34d399` (emerald) |
| 11–13 | Kim Đan | `#facc15` (yellow) |
| 14–16 | Nguyên Anh | `#fb923c` (orange) |
| 17–19 | Hóa Thần | `#f472b6` (pink) |
| 20 | Luyện Hư | `#a78bfa` (violet) |
| 21 | Hợp Thể | `#60a5fa` (blue) |
| 22 | Đại Thừa | `#38bdf8` (sky) |
| 23 | Độ Kiếp | `#f87171` (red) |
| 24 | Phi Thăng Tiên Giới | `#fbbf24` (gold) |

Helper functions:
- `getLevelInfo(totalExp)` — returns the `XianxiaLevel` object for any EXP total.
- `getLevelProgress(totalExp)` — 0.0–1.0 progress within current level.
- `getExpToNextLevel(totalExp)` — EXP remaining to next level (0 at max).
- `formatExp(exp)` — pretty-prints (`1.5K`, `2.3M`).

### Database Schema (XP Tables)

```sql
-- One row per user+chapter+mode (unique constraint prevents double XP)
user_chapter_completions (
  user_id, chapter_id, book_id, mode, word_count, exp_earned, completed_at
  UNIQUE(user_id, chapter_id, mode)
)

-- Aggregate stats (updated on every completion via upsert)
user_stats (
  user_id PRIMARY KEY,
  total_exp,
  total_chapters_read,
  total_chapters_listened,
  total_words_read,
  updated_at
)
```

---

## 10. Data Flow Diagrams

### Listen Page Load (native, online)

```
URL: /listen?id=<bookId>&chapter=<chapterId>&autoplay=1
  → ListenPageClient mounts
  → React Query: getBook, getAllBookChapters, getChapterText (hits IndexedDB first on native)
  → useEffect[bookDataId, chapterId]: setTrack(PlayerTrack)
  → PlayerContext → useNativeTTSPlayer(chapterId, text, voice, onEnded)
  → reset effect: stopPlayback(); startNativePlayback(initialChunkIndex)
    → bridge.playChunksWithId(chunks, rate, pitch, startIdx, title, chapterId)
    → TtsBridge.playChunksWithId → TtsPlaybackService.playChunks
    → TTS engine begins speaking
  → queue effect: gathers 10 upcoming chapters → bridge.mergeQueuedChapters
```

### Native Auto-Advance (screen on)

```
TtsPlaybackService.onChunkFinished (main thread):
  → poll chapterQueue
  → capture completedId, newChapterId
  → completedChapterIds.add(completedId)
  → dispatchJs("native-tts-chapter-advance", {completedChapterId, newChapterId})
  → startChapter(nextChapter, 0)

WebView receives event:
  useNativeTTSPlayer.onChapterAdvance:
    → lastAdvancedChapterRef dedup check
    → chapterAdvancedRef.current = true
    → onEndedRef.current(newChapterId)

ListenPageClient.onEnded(nativeChapterId):
  → wasAutoAdvanceRef.current = true
  → router.replace("/listen?...&chapter=newChapterId&autoplay=1")

New route mounts ListenPageClient with new chapterId:
  → queue effect: wasAutoAdvanceRef is true → skip queue rebuild
  → reset effect: nativeAlreadyPlaying → sync state, skip stopPlayback
```

### Screen-Off then Screen-On

```
Screen off:
  Java service continues: chapter 3 → 4 → 5 → 6
  completedChapterIds = [ch3, ch4, ch5]
  WebView: suspended, JS events queued

Screen on:
  WebView resumes, queued evaluateJavascript calls flush:
    → 3× native-tts-chapter-advance events fire
    → lastAdvancedChapterRef dedup: only ch6 navigation executes (last one wins)
    → router.replace to ch6

  handleVisibilityChange fires:
    → bridge.getCurrentChapterId() → ch6 (confirms)
    → if mismatch: router.replace (safety net, no-op since already at ch6)

  XP safety net (visibilitychange):
    → bridge.getCompletedChapterIds() → ["ch3", "ch4", "ch5"]
    → api.completeChapter × 3 (listenXpCompletedRef guards against duplicates)
```

### Reading XP Award Flow

```
User opens ReadPage for chapter X
  → useReadingXp mounted: timeRef=0, scrolledPastRef=false

User scrolls past 25%:
  → scrolledPastRef = true

setInterval(tick, 2000):
  → tab visible: timeRef += 2
  → tab hidden: timer pauses

timeRef >= threshold AND scrolledPastRef:
  → completedRef.add(chapterId)
  → api.completeChapter({mode: "read", word_count, ...})
  → backend: idempotency check → insert completion → upsert user_stats
```

---

*Last updated: 2026-03-27 — added profile edit (display name + avatar), Providers section, auth.ts AuthUser fields, auth.py update-profile endpoint.*
