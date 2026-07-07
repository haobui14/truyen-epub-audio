"use client";
/**
 * ListenPageClient — the /listen route.
 *
 * ## Native-TTS navigation effects (declaration order = React effect-order)
 *
 * 1. `visibilitychange` handler — registered if voice is native:. Fires on
 *    tab-visibility transitions; if native is on a different chapter,
 *    `router.replace(…autoplay=1)` to native's chapter.
 *
 * 2. Cold-start sync — runs once per mount after allChapters loads. Same
 *    logic as above but handles the case where the WebView was OS-killed and
 *    reloaded with a stale URL. Sets `coldStartReplacingRef` if replacing so
 *    the stale-session guard below skips one render.
 *
 * 3. Stale-session guard — runs on `[chapterId, voice, autoPlay]` changes.
 *    When URL lacks `autoplay=1` AND native is on a different chapter, calls
 *    `bridge.stopPlayback()` so a leftover native session doesn't fire a
 *    chapter-advance event that drags JS forward. See invariant I6.
 *
 * 4. Effect A (`setPendingChapters`) — hands Java the full upcoming-chapter
 *    playlist (id + title + rate + pitch per chapter). Self-fetch metadata
 *    only; no text. Re-fires on chapterId/rate/pitch changes.
 *
 * 5. Effect B (`mergeQueuedChapters`) — pushes pre-loaded chapter TEXT chunks
 *    into Java's chapterQueue as preload queries complete. Java dedupes
 *    existing entries.
 *
 * ## See also
 * - docs/android-player.md — full state machine, event map, invariants
 * - useNativeTTSPlayer — JS hook that handles native-tts-* events
 * - TtsPlaybackService — the Java foreground service
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams, useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "@/lib/api";
import { isLoggedIn, getUser, getToken } from "@/lib/auth";
import { SpeechPlayer } from "@/components/player/SpeechPlayer";
import { Spinner } from "@/components/ui/Spinner";
import { usePlayerContext } from "@/context/PlayerContext";
import { splitIntoChunks } from "@/lib/textChunks";
import {
  cacheChapterText,
  isChapterTextCached,
  getCachedChapterText,
  getAllCachedChapterIds,
} from "@/lib/chapterTextCache";
import { isNativePlatform } from "@/lib/capacitor";
import {
  getLocalProgress,
  saveLocalProgress,
  saveLocalBookProgress,
  syncBookProgressToServer,
} from "@/lib/progressQueue";
import { useProgressSync } from "@/hooks/useProgressSync";
import { prefetchNextChapterAudio } from "@/hooks/useSpeechPlayer";
import { getTtsBridge } from "@/lib/backgroundLock";
import { API_URL } from "@/lib/constants";
import { splitIntoChunks as splitChunks } from "@/lib/textChunks";
import {
  getCachedBook,
  cacheBook,
  getCachedChapters,
  getCachedAllChapters,
  cacheAllChapters,
} from "@/lib/bookCache";

export default function ListenPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const bookId = (searchParams.get("id") ||
    (params?.bookId as string) ||
    "") as string;
  const chapterId = searchParams.get("chapter");
  const autoPlay = searchParams.get("autoplay") === "1";
  const router = useRouter();

  // Track last-listened chapter per book in localStorage so the BookDetail
  // "Continue Listening" button resumes here rather than at the reading position
  // (reading and listening share a single DB progress row since progress_type was removed).
  useEffect(() => {
    if (chapterId && bookId) {
      localStorage.setItem(`listen-chapter:${bookId}`, chapterId);
      // Timestamp lets BookDetail / the app-open reconciler compare this
      // pointer's freshness against Java's durable last-position.
      localStorage.setItem(`listen-chapter-ts:${bookId}`, String(Date.now()));
    }
  }, [bookId, chapterId]);

  const { data: book, isPending: bookPending } = useQuery({
    queryKey: ["book", bookId],
    queryFn: async () => {
      try {
        const data = await api.getBook(bookId);
        cacheBook(data).catch(() => {});
        return data;
      } catch {
        const cached = await getCachedBook(bookId);
        if (cached) return cached;
        throw new Error("offline");
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  const { data: chaptersData, isPending: chaptersPending } = useQuery({
    queryKey: ["chapters", bookId, "all"],
    queryFn: async () => {
      try {
        const data = await api.getAllBookChapters(bookId);
        // Cache the full flat list so offline fallback always has ALL chapters.
        cacheAllChapters(bookId, data).catch(() => {});
        return data;
      } catch {
        // Offline — try the dedicated all-chapters snapshot first (written
        // whenever the listen page loads online; also written by handleDownloadBook).
        const allCached = await getCachedAllChapters(bookId);
        if (allCached) return allCached;
        // Fall back to stitching together paginated caches (written by BookDetailClient).
        const page1 = await getCachedChapters(bookId, 1);
        if (!page1) throw new Error("offline");
        if (page1.total_pages <= 1) return page1;
        const rest = await Promise.all(
          Array.from({ length: page1.total_pages - 1 }, (_, i) =>
            getCachedChapters(bookId, i + 2),
          ),
        );
        const allItems = [page1, ...rest.filter(Boolean)].flatMap(
          (p) => p!.items,
        );
        return { ...page1, items: allItems };
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  // Fetch text for the current chapter — on native checks IndexedDB first,
  // then falls back to IndexedDB again if the API call fails.
  // Auto-caches to IndexedDB on native so Java's mergeQueuedChapters can
  // populate the screen-off queue without any network fetches.
  const { data: chapterText, isLoading: isLoadingText } = useQuery({
    queryKey: ["chapterText", chapterId],
    queryFn: async () => {
      if (isNativePlatform()) {
        const cached = await getCachedChapterText(chapterId!);
        if (cached) return { id: chapterId!, text_content: cached };
      }
      try {
        const data = await api.getChapterText(chapterId!);
        // Persist to IndexedDB so Java can find it in mergeQueuedChapters
        // even after the app is restarted or React Query cache is cold.
        if (isNativePlatform()) {
          cacheChapterText(chapterId!, data.text_content).catch(() => {});
        }
        return data;
      } catch {
        // Offline or API error — try local cache
        const cached = await getCachedChapterText(chapterId!);
        if (cached) return { id: chapterId!, text_content: cached };
        throw new Error("Không có kết nối và chưa lưu offline");
      }
    },
    enabled: !!chapterId,
    staleTime: Infinity,
  });

  // Fetch saved listening progress — falls back to offline queue.
  // Use getBookProgress (one row per book) and only restore if it's for THIS chapter.
  // getChapterProgress queries by chapter_id but the DB stores only the latest chapter
  // per book, so it returns null for any chapter that isn't the most recently visited.
  const { data: listenProgress } = useQuery({
    queryKey: ["progress", bookId, chapterId],
    queryFn: async () => {
      // IndexedDB position in the UserProgress response shape — the offline
      // fallback for accounts, and the ONLY store guests have.
      const fromLocal = async () => {
        const queued = await getLocalProgress(chapterId!);
        if (!queued) return null;
        return {
          id: "",
          user_id: "",
          book_id: queued.book_id,
          chapter_id: queued.chapter_id,
          progress_value: queued.progress_value,
          total_value: queued.total_value,
          updated_at: new Date(queued.updated_at).toISOString(),
        };
      };
      if (!isLoggedIn()) return fromLocal();
      try {
        const progress = await api.getBookProgress(bookId);
        if (progress?.chapter_id === chapterId) return progress;
        return null;
      } catch {
        return fromLocal();
      }
    },
    enabled: !!chapterId,
  });

  const allChapters = useMemo(() => chaptersData?.items ?? [], [chaptersData]);
  // Index by chapter_index once so the many neighbor lookups below are O(1)
  // instead of O(N) scans — this subtree re-renders on every native-tts-chunk
  // event (~every 300ms during playback), so on a 2000-chapter book the old
  // ~14 find() calls per render were a measurable CPU drain on cheap devices.
  const chapterByIndex = useMemo(() => {
    const m = new Map<number, (typeof allChapters)[number]>();
    for (const c of allChapters) m.set(c.chapter_index, c);
    return m;
  }, [allChapters]);
  const currentChapter = useMemo(
    () => allChapters.find((c) => c.id === chapterId) ?? null,
    [allChapters, chapterId],
  );
  const currentIndex = currentChapter?.chapter_index ?? -1;

  const prevChapter = chapterByIndex.get(currentIndex - 1) ?? null;
  const nextChapter = chapterByIndex.get(currentIndex + 1) ?? null;

  // Preload adjacent + upcoming chapter texts.
  // On native, each successful API fetch is persisted to IndexedDB so Java's
  // mergeQueuedChapters has real data to queue — enabling seamless screen-off
  // playback without any network dependency inside the Java service.
  const prevChapterId = prevChapter?.id ?? null;
  const nextChapterId = nextChapter?.id ?? null;
  const next2Chapter = chapterByIndex.get(currentIndex + 2) ?? null;
  const next3Chapter = chapterByIndex.get(currentIndex + 3) ?? null;
  const next4Chapter = chapterByIndex.get(currentIndex + 4) ?? null;
  const next5Chapter = chapterByIndex.get(currentIndex + 5) ?? null;
  const next6Chapter = chapterByIndex.get(currentIndex + 6) ?? null;
  const next2ChapterId = next2Chapter?.id ?? null;
  const next3ChapterId = next3Chapter?.id ?? null;
  const next4ChapterId = next4Chapter?.id ?? null;
  const next5ChapterId = next5Chapter?.id ?? null;
  const next6ChapterId = next6Chapter?.id ?? null;

  // Helper: fetch from API, auto-cache on native, fall back to IndexedDB.
  const fetchAndCacheText = useCallback(
    async (id: string) => {
      if (isNativePlatform()) {
        const cached = await getCachedChapterText(id);
        if (cached) return { id, text_content: cached };
      }
      try {
        const data = await api.getChapterText(id);
        if (isNativePlatform()) {
          cacheChapterText(id, data.text_content).catch(() => {});
        }
        return data;
      } catch {
        const cached = await getCachedChapterText(id);
        if (cached) return { id, text_content: cached };
        throw new Error("offline");
      }
    },
    [],
  );

  useQuery({
    queryKey: ["chapterText", prevChapterId],
    queryFn: () => fetchAndCacheText(prevChapterId!),
    enabled: !!prevChapterId,
    staleTime: Infinity,
  });
  const { data: nextChapterTextData } = useQuery({
    queryKey: ["chapterText", nextChapterId],
    queryFn: () => fetchAndCacheText(nextChapterId!),
    enabled: !!nextChapterId,
    staleTime: Infinity,
  });
  // N+2 through N+6: preload and cache so Java's queue stays deep enough that
  // the self-fetch never becomes urgent during normal screen-off playback.
  // Capturing the data lets the queue seeding effect re-run incrementally as
  // texts become available, delivering them to the Java queue right away.
  const { data: next2ChapterTextData } = useQuery({
    queryKey: ["chapterText", next2ChapterId],
    queryFn: () => fetchAndCacheText(next2ChapterId!),
    enabled: !!next2ChapterId,
    staleTime: Infinity,
  });
  const { data: next3ChapterTextData } = useQuery({
    queryKey: ["chapterText", next3ChapterId],
    queryFn: () => fetchAndCacheText(next3ChapterId!),
    enabled: !!next3ChapterId,
    staleTime: Infinity,
  });
  const { data: next4ChapterTextData } = useQuery({
    queryKey: ["chapterText", next4ChapterId],
    queryFn: () => fetchAndCacheText(next4ChapterId!),
    enabled: !!next4ChapterId,
    staleTime: Infinity,
  });
  const { data: next5ChapterTextData } = useQuery({
    queryKey: ["chapterText", next5ChapterId],
    queryFn: () => fetchAndCacheText(next5ChapterId!),
    enabled: !!next5ChapterId,
    staleTime: Infinity,
  });
  const { data: next6ChapterTextData } = useQuery({
    queryKey: ["chapterText", next6ChapterId],
    queryFn: () => fetchAndCacheText(next6ChapterId!),
    enabled: !!next6ChapterId,
    staleTime: Infinity,
  });

  const neighborChapters = useMemo(
    () =>
      [-2, -1, 0, 1, 2, 3]
        .map((offset) => chapterByIndex.get(currentIndex + offset))
        .filter(
          (c): c is NonNullable<typeof c> =>
            !!c && c.id !== chapterId && c.status === "ready",
        )
        .concat(currentChapter?.status === "ready" ? [currentChapter] : [])
        .map((c) => ({ id: c.id })),
    [chapterByIndex, currentIndex, chapterId, currentChapter],
  );

  const navigateTo = useCallback(
    (chapter: typeof currentChapter, autoplay = false) => {
      if (chapter) {
        // For user-initiated navigation (autoplay=false), stop native immediately
        // so that useNativeTTSPlayer's nativeIsAhead guard sees isPlaying=false and
        // allows the new chapter to start.  Auto-advance paths (autoplay=true) must
        // NOT stop native — the service is already playing the next chapter.
        if (!autoplay && isNativePlatform()) {
          getTtsBridge()?.stopPlayback();
        }
        const url = `/listen?id=${bookId}&chapter=${chapter.id}${autoplay ? "&autoplay=1" : ""}`;
        router.push(url);
      }
    },
    [bookId, router],
  );

  const queryClient = useQueryClient();
  const { setTrack, chunkIndex, totalChunks, voice, rate, pitch } =
    usePlayerContext();

  const { reportProgress } = useProgressSync({
    bookId,
    chapterId: chapterId ?? "",
    chapterIndex: currentIndex >= 0 ? currentIndex : undefined,
  });

  // Save listen progress whenever the chunk index advances.
  // Use a ref for reportProgress so it doesn't trigger the effect when
  // chapterId changes (which recreates the useProgressSync callbacks).
  // Without this, the effect re-fires with stale chunkIndex/totalChunks
  // from the previous chapter, corrupting the new chapter's progress and
  // causing a cascade where the player skips ahead many chapters.
  const reportProgressRef = useRef(reportProgress);
  useEffect(() => {
    reportProgressRef.current = reportProgress;
  }, [reportProgress]);
  const settledChapterRef = useRef<string | null>(null);
  const staleChunkRef = useRef<number>(-1);
  useEffect(() => {
    if (!chapterId || totalChunks === 0) return;
    if (settledChapterRef.current !== chapterId) {
      settledChapterRef.current = chapterId;
      staleChunkRef.current = chunkIndex; // Remember potentially stale value
      return; // Wait for first real chunk update before reporting
    }
    // After chapter change, skip until chunkIndex actually changes from
    // the stale value carried over from the previous chapter.
    if (staleChunkRef.current >= 0 && chunkIndex === staleChunkRef.current) {
      return;
    }
    staleChunkRef.current = -1;
    reportProgressRef.current(chunkIndex, totalChunks);
  }, [chapterId, chunkIndex, totalChunks]);

  // Save book-level progress locally whenever the chapter changes.
  // This ensures every chapter visited is captured in the local DB
  // even when the screen is off or the app is killed.
  useEffect(() => {
    if (!chapterId || !bookId || currentIndex < 0) return;
    saveLocalBookProgress({
      book_id: bookId,
      chapter_id: chapterId,
      chapter_index: currentIndex,
      progress_value: 0,
    });
  }, [bookId, chapterId, currentIndex]);

  // Award XP when the user has listened to ≥80% of the chapter.
  // Uses a ref set so each chapter+mode is only awarded once per session.
  const listenXpCompletedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!chapterId || !bookId || totalChunks === 0 || !isLoggedIn()) return;
    if (listenXpCompletedRef.current.has(chapterId)) return;
    if (chunkIndex / totalChunks >= 0.8) {
      listenXpCompletedRef.current.add(chapterId);
      api
        .completeChapter({
          chapter_id: chapterId,
          book_id: bookId,
          mode: "listen",
          word_count: currentChapter?.word_count ?? 0,
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunkIndex, totalChunks]);

  // Award XP when native auto-advance fires a chapter-complete event.
  // This covers the normal case AND the screen-off case where JS was throttled:
  // the WebView event queue is flushed on screen-on, so this handler fires even
  // if the chapter finished while the screen was dark.
  useEffect(() => {
    if (!bookId || !isLoggedIn()) return;
    const onAdvance = (e: Event) => {
      const completedId = (e as CustomEvent<{ completedChapterId?: string }>)
        .detail?.completedChapterId;
      if (!completedId || listenXpCompletedRef.current.has(completedId)) return;
      listenXpCompletedRef.current.add(completedId);
      const ch = allChapters.find((c) => c.id === completedId);
      api
        .completeChapter({
          chapter_id: completedId,
          book_id: bookId,
          mode: "listen",
          word_count: ch?.word_count ?? 0,
        })
        .catch(() => {});
    };
    window.addEventListener("native-tts-chapter-advance", onAdvance);
    return () =>
      window.removeEventListener("native-tts-chapter-advance", onAdvance);
  }, [bookId, allChapters]);

  // Drain the Java-side completed-chapter list and award listen XP for each
  // newly-completed chapter. getCompletedChapterIds() clears the list as it
  // reads, and listenXpCompletedRef + the backend both dedupe, so calling this
  // from multiple triggers is safe.
  const drainCompletedListenXp = useCallback(() => {
    if (!bookId || !isNativePlatform() || !isLoggedIn()) return;
    // word_count is REQUIRED for correct XP (max(10, words/50)·1.5) and the
    // backend dedupes the FIRST submission per chapter — draining before the
    // chapter list loads would permanently award the 10-XP minimum. The ids
    // wait in Java (getCompletedChapterIds only clears when called).
    if (allChapters.length === 0) return;
    const bridge = getTtsBridge();
    if (!bridge) return;
    try {
      const ids = JSON.parse(bridge.getCompletedChapterIds()) as string[];
      ids.forEach((completedId) => {
        if (listenXpCompletedRef.current.has(completedId)) return;
        listenXpCompletedRef.current.add(completedId);
        const ch = allChapters.find((c) => c.id === completedId);
        api
          .completeChapter({
            chapter_id: completedId,
            book_id: bookId,
            mode: "listen",
            word_count: ch?.word_count ?? 0,
          })
          .catch(() => {});
      });
    } catch {
      /* ignore JSON parse errors */
    }
  }, [bookId, allChapters]);

  // Screen-on safety net: drain when the WebView becomes visible again.
  // If the WebView was completely suspended (deep doze / screen off for a long time),
  // the queued JS evaluations may not have been processed yet, so the per-advance
  // handler above might not have fired. Reading the list directly from the bridge
  // ensures we never miss XP even in that case.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return;
      drainCompletedListenXp();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [drainCompletedListenXp]);

  // Award the FINAL chapter's XP the instant playback ends. The last chapter
  // finishes via native-tts-done (there's no chapter-advance), and Java records
  // it in completedChapterIds right before dispatching the event, so draining
  // here credits it immediately — including short final chapters that never
  // cross the ≥80%-listened threshold. The sleep timer also fires
  // native-tts-done but does NOT add to completedChapterIds, so stopping
  // mid-chapter on a sleep timer correctly awards nothing.
  useEffect(() => {
    const onDone = () => drainCompletedListenXp();
    window.addEventListener("native-tts-done", onDone);
    return () => window.removeEventListener("native-tts-done", onDone);
  }, [drainCompletedListenXp]);

  // Auto-sync book progress to server when network comes back online
  useEffect(() => {
    if (!bookId) return;
    const handleOnline = () => {
      syncBookProgressToServer(bookId).catch(() => {});
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [bookId]);

  const [isCached, setIsCached] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [showText, setShowText] = useState(false);
  const [chapterSearch, setChapterSearch] = useState("");
  const [showEditModal, setShowEditModal] = useState(false);
  const [editText, setEditText] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const isAdmin = getUser()?.role === "admin";
  const activeChunkRef = useRef<HTMLDivElement>(null);
  const chapterListRef = useRef<HTMLDivElement>(null);
  const chapterListScrolledRef = useRef(false);

  // ── Chapter list (virtualized so big books don't mount thousands of rows) ──
  const isNative = isNativePlatform();
  const filteredChapters = useMemo(() => {
    const q = chapterSearch.trim().toLowerCase();
    if (!q) return allChapters;
    return allChapters.filter(
      (ch) =>
        ch.title.toLowerCase().includes(q) ||
        String(ch.chapter_index + 1).includes(q),
    );
  }, [allChapters, chapterSearch]);
  const activeChapterListIndex = useMemo(
    () => filteredChapters.findIndex((c) => c.id === chapterId),
    [filteredChapters, chapterId],
  );
  const chapterRowVirtualizer = useVirtualizer({
    count: filteredChapters.length,
    getScrollElement: () => chapterListRef.current,
    estimateSize: () => 41,
    overscan: 8,
  });

  // Signals that the next chapter should auto-play. Set synchronously before
  // navigation so the setTrack effect always sees autoPlay=true on chapter
  // advance, regardless of whether searchParams updates before the effect fires
  // (can be unreliable on Capacitor static-export builds).
  const autoPlayNextRef = useRef(false);

  // Always-current chapter ID ref — used by the visibility-change handler
  // inside a setTimeout closure where the stale closure value would be wrong.
  const chapterIdRef = useRef(chapterId);
  chapterIdRef.current = chapterId;

  // Guards the one-shot cold-start native sync so it only runs once per mount
  // even though its effect dependencies include allChapters (which updates later).
  const nativeInitSyncDoneRef = useRef(false);
  // Set when cold-start sync schedules a router.replace so the stale-session
  // guard below skips the render cycle in which the URL hasn't committed yet.
  // Load-bearing: cold-start-sync and stale-session-guard observe identical
  // native state (native playing a chapter ≠ chapterId) but want opposite
  // outcomes (sync JS to native vs. stop native). The ref is the only signal
  // that distinguishes "cold-start sync just scheduled the replace" from
  // "user landed here via a Link while a stale session was playing".
  const coldStartReplacingRef = useRef(false);

  const chapterTextContent = chapterText?.text_content ?? null;
  const chunks = useMemo(
    () => (chapterTextContent ? splitIntoChunks(chapterTextContent) : []),
    [chapterTextContent],
  );

  // Check if already cached
  useEffect(() => {
    if (!chapterId) return;
    isChapterTextCached(chapterId).then(setIsCached);
  }, [chapterId]);

  // Load all cached chapter IDs for per-chapter offline badges (native only)
  useEffect(() => {
    if (!isNativePlatform()) return;
    getAllCachedChapterIds().then((ids) => setCachedIds(new Set(ids)));
  }, []);

  // ── Shared native-sync helper ────────────────────────────────────────────
  // If native is playing a chapter different from JS's current chapterId,
  // persist the native chapter's progress locally + server-side, then
  // router.replace to the native chapter with autoplay=1. Returns true if a
  // replace was issued so the caller can track the in-flight redirect.
  //
  // Used by BOTH:
  //   - visibilitychange handler (screen-off resume cascade)
  //   - cold-start sync (WebView was OS-killed, service survived)
  // See docs/android-player.md §4 nav entry points.
  const syncJsToNativeChapter = useCallback((): boolean => {
    const bridge = getTtsBridge();
    if (!bridge || typeof bridge.getCurrentChapterId !== "function") return false;
    const nativeChapterId = bridge.getCurrentChapterId();
    if (!nativeChapterId || nativeChapterId === chapterId) return false;

    const targetChapter = allChapters.find((c) => c.id === nativeChapterId);
    if (!targetChapter) return false;

    const nativeChunk = bridge.getCurrentChunk();
    const nativePlaying = bridge.isPlaying?.() ?? false;
    saveLocalBookProgress({
      book_id: bookId,
      chapter_id: nativeChapterId,
      chapter_index: targetChapter.chapter_index,
      progress_value: nativeChunk >= 0 ? nativeChunk : 0,
    });
    // Chapter-level row too: the listenProgress query's offline fallback reads
    // getLocalProgress(chapterId), so without this an offline cold start lands
    // on the right chapter but at chunk 0.
    saveLocalProgress({
      book_id: bookId,
      chapter_id: nativeChapterId,
      progress_value: nativeChunk >= 0 ? nativeChunk : 0,
    });
    localStorage.setItem(`listen-chapter:${bookId}`, nativeChapterId);
    localStorage.setItem(`listen-chapter-ts:${bookId}`, String(Date.now()));
    syncBookProgressToServer(bookId).catch(() => {});

    // Autoplay only when native is ACTUALLY playing (the WebView was
    // suspended mid-listen and the user expects playback to continue —
    // omitting &autoplay=1 would leave the player paused since setTrack won't
    // re-fire for the same chapterId). When native is paused — a session
    // restored after a process kill, or the user paused from the notification
    // while the screen was off — autoplaying would start audio the user
    // didn't ask for; land on the chapter paused instead.
    router.replace(
      `/listen?id=${bookId}&chapter=${nativeChapterId}${nativePlaying ? "&autoplay=1" : ""}`,
    );
    return true;
  }, [chapterId, allChapters, bookId, router]);

  // ── visibilitychange: sync on screen-on/tab-visible transitions ──
  // When the WebView is suspended (screen off), native auto-advances chapters
  // but JS events may be throttled. On resume, reconcile JS with native.
  useEffect(() => {
    if (!voice.startsWith("native:")) return;
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const replaced = syncJsToNativeChapter();
      if (!replaced) {
        // Same chapter or no native chapter — still sync progress to server
        syncBookProgressToServer(bookId).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [voice, bookId, syncJsToNativeChapter]);

  // ── Cold-start sync: run once when allChapters loads ──
  // visibilitychange only fires on state *transitions*. If the OS killed the
  // WebView while TtsPlaybackService kept running, the document is already
  // visible on page load so no visibilitychange event fires.
  useEffect(() => {
    if (!voice.startsWith("native:") || allChapters.length === 0) return;
    if (nativeInitSyncDoneRef.current) return;

    // After a process kill the foreground service rebinds asynchronously
    // (~100-500ms). Until it does, bridge.getCurrentChapterId() returns "" and
    // syncJsToNativeChapter() no-ops. Latching nativeInitSyncDoneRef before the
    // service is ready would permanently skip the sync, stranding the listener
    // on the wrong chapter URL with no correction. So poll briefly for the
    // service to bind before giving up (a genuine cold launch with nothing
    // playing simply exhausts the retries and no-ops — harmless).
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (nativeInitSyncDoneRef.current) return;
      const bridge = getTtsBridge();
      const serviceReady = !!bridge?.getCurrentChapterId?.();
      if (!serviceReady && tries++ < 12) {
        timer = setTimeout(attempt, 250);
        return;
      }
      nativeInitSyncDoneRef.current = true;
      const replaced = syncJsToNativeChapter();
      if (replaced) {
        // Stale-session guard (below) will otherwise see the pre-replace state
        // and stop native before the replace commits. Skip the guard for one render.
        coldStartReplacingRef.current = true;
      }
    };
    attempt();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [voice, allChapters, syncJsToNativeChapter]);

  // ── Stale-session guard ─────────────────────────────────────────────────
  // Arrive at /listen via a path that bypasses navigateTo (e.g. a Link on the
  // book detail page, MiniPlayer, chapter list) while a leftover native
  // session is still playing a different chapter — stop it before its next
  // auto-advance fires a chapter-advance event that would drag JS forward to
  // whatever chapter native happens to be on (can be dozens ahead).
  //
  // Skipped when autoplay=1 is in the URL: those come from legitimate sync
  // paths (visibilitychange handler, cold-start sync, onEnded post-navigation)
  // where native is intentionally ahead and must continue playing.
  //
  // Also skipped during a cold-start sync redirect — cold-start sync schedules
  // a router.replace to the chapter native is actually on, but its replace has
  // not committed by the time this effect runs. Stopping native now would kill
  // the seamless OS-kill resume. The flag clears after one render so subsequent
  // user navs are still caught.
  useEffect(() => {
    if (!voice.startsWith("native:") || !chapterId) return;
    // Consume the cold-start replace flag FIRST — before the autoPlay/pending
    // checks — so it can never linger past the one render it's meant to cover.
    // (The async service-bind retry in cold-start sync can set this flag in a
    // tick where the very next guard run already sees autoplay=1, which would
    // otherwise leave the flag set and skip a later legitimate stale-stop.)
    if (coldStartReplacingRef.current) {
      coldStartReplacingRef.current = false;
      return;
    }
    if (autoPlay) return;
    // Wait until the chapter list has loaded. While chaptersPending, the
    // cold-start sync effect above has bailed (allChapters empty) without
    // claiming coldStartReplacingRef — so running now against a live background
    // session on a different chapter would stopPlayback() and KILL it before
    // cold-start sync ever adopts it. Once chapters load both effects re-run in
    // declaration order (sync first), and coldStartReplacingRef guards us.
    if (chaptersPending) return;
    const bridge = getTtsBridge();
    if (!bridge) return;
    const nativeChId = bridge.getCurrentChapterId?.() ?? "";
    const nativePlaying = bridge.isPlaying?.() ?? false;
    if (nativePlaying && nativeChId && nativeChId !== chapterId) {
      // Stop the in-flight chunk AND wipe Java's queues. Without the queue
      // wipe, native auto-advances to the next chapter in the previous book's
      // playlist (the one seeded by `setPendingChapters`) and the user keeps
      // hearing the old book. Effect A below will re-seed with the current
      // book once allChapters resolves.
      bridge.stopPlayback();
      try {
        bridge.clearNextChapter?.();
      } catch {}
      try {
        bridge.setPendingChapters?.("[]", "", "");
      } catch {}
    }
  }, [chapterId, voice, autoPlay, chaptersPending]);

  // ── Native TTS: seed the Java queue and hand it the full chapter playlist ──
  //
  // Effect A: setPendingChapters — runs ONCE per chapter (chapterId / allChapters).
  //   Synchronously gives Java the full ordered chapter list so its self-fetch
  //   can run even if the WebView is suspended before the texts below load.
  //   Intentionally does NOT depend on preload text data to avoid killing the
  //   Java self-fetch chain every time a single preload query completes.
  //
  // Effect B: mergeQueuedChapters — runs whenever a preload text becomes available.
  //   Sends the actual chunk data so Java can auto-advance without any network
  //   fetch. The Java side buffers calls that arrive before playChunks runs
  //   (race-condition safety) so the chapters are never lost.
  const nextChapterText = nextChapterTextData?.text_content ?? null;

  // Effect A: hand Java the full chapter playlist (self-fetch metadata only)
  useEffect(() => {
    if (
      !voice.startsWith("native:") ||
      allChapters.length === 0 ||
      currentIndex < 0
    )
      return;
    const bridge = getTtsBridge();
    if (!bridge || typeof bridge.setPendingChapters !== "function") return;

    // Seed the upcoming playlist INCLUSIVE of the current chapter. Java's
    // self-fetch (TtsPlaybackService.doPrefetchStep) locates the current chapter
    // inside this list to decide what to fetch next; if the current chapter is
    // absent it treats the playlist as stale and STOPS instead of jumping. So
    // the current chapter must be present — and re-seeding on every chapterId
    // change keeps the playlist aligned with where playback actually is, even
    // after the user jumps to an earlier chapter (the bug this fixes: leftover
    // playlist from the old position would otherwise leap the listener forward
    // to ~that chapter once the JS-preloaded queue drained while the screen
    // was off).
    // No status filter: native device TTS needs text content, not server audio.
    // Chapters with status "converting" or "error" may still have text available.
    const playlistChapters = allChapters
      .filter((c) => c.chapter_index >= currentIndex)
      .sort((a, b) => a.chapter_index - b.chapter_index);

    const token = getToken() ?? "";

    // On the last chapter this is just [current]: Java aligns on it, finds
    // nothing after it, and fires native-tts-done — and because it OVERWRITES
    // any leftover playlist, no stale entries survive to jump back into.
    const meta = playlistChapters.map((ch) => ({
      id: ch.id,
      title: ch.title ?? "",
      rate,
      pitch,
    }));
    bridge.setPendingChapters(JSON.stringify(meta), API_URL, token);
  }, [voice, allChapters, currentIndex, chapterId, rate, pitch]);

  // Effect B: push chapter text chunks into the Java queue as they become available.
  // Runs once initially and again each time a preload text loads so the queue
  // is topped up incrementally without waiting for all texts to arrive.
  useEffect(() => {
    if (
      !voice.startsWith("native:") ||
      allChapters.length === 0 ||
      currentIndex < 0
    )
      return;
    const bridge = getTtsBridge();
    if (!bridge) return;

    // Scan up to 50 chapters ahead (matches Java's chapterQueue cap of 50).
    // No status filter: native device TTS only needs text content, not server audio.
    // Chapters with status "converting" or "error" may still have text in IndexedDB.
    const remainingChapters = allChapters
      .filter((c) => c.chapter_index > currentIndex)
      .sort((a, b) => a.chapter_index - b.chapter_index)
      .slice(0, 50);

    if (remainingChapters.length === 0) return;

    let cancelled = false;

    (async () => {
      // The Java pendingMergeBuffer now handles the race where mergeQueuedChapters
      // arrives before playChunks. We still delay slightly (50ms) to give the
      // bridge call time to post to the mainHandler queue AFTER playChunksWithId
      // when chapter text is already cached (instant load). For slow networks,
      // playChunks will have already run before our 50ms fires, so timing is safe.
      await new Promise((r) => setTimeout(r, 50));
      if (cancelled) return;

      type QueueItem = {
        chunks: string[];
        chapterId: string;
        title: string;
        rate: number;
        pitch: number;
      };
      const cachedItems: QueueItem[] = [];

      for (const ch of remainingChapters) {
        // Bail out inside the loop — each getCachedChapterText is an IndexedDB
        // await that yields to the event loop. A new dep change can set cancelled
        // while we're mid-loop; checking here prevents a stale mergeQueuedChapters.
        if (cancelled) return;

        let text: string | null = null;
        // 1. React Query cache (synchronous, no await needed)
        const qcData = queryClient.getQueryData<{ text_content: string }>([
          "chapterText",
          ch.id,
        ]);
        if (qcData?.text_content) {
          text = qcData.text_content;
        } else {
          // 2. IndexedDB (async)
          try {
            text = await getCachedChapterText(ch.id);
          } catch {
            /* not cached */
          }
        }

        if (cancelled) return;

        if (text) {
          const chunks = splitChunks(text);
          if (chunks.length > 0) {
            cachedItems.push({
              chunks,
              chapterId: ch.id,
              title: ch.title ?? "Đang phát...",
              rate,
              pitch,
            });
          }
        }
      }

      if (cancelled) return;
      if (cachedItems.length > 0) {
        bridge.mergeQueuedChapters(JSON.stringify(cachedItems));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chapterId, voice, rate, pitch, allChapters, currentIndex, queryClient,
    // Re-run as each preload text arrives so the queue is topped up incrementally.
    nextChapterTextData?.text_content,
    next2ChapterTextData?.text_content,
    next3ChapterTextData?.text_content,
    next4ChapterTextData?.text_content,
    next5ChapterTextData?.text_content,
    next6ChapterTextData?.text_content,
  ]);

  // ── Web streaming: prefetch first TTS audio chunks when near end ──
  // Backend voices only — native and browser engines never fetch backend audio.
  useEffect(() => {
    if (
      !nextChapterId ||
      !nextChapterText ||
      voice.startsWith("native:") ||
      voice.startsWith("browser:")
    )
      return;
    if (totalChunks === 0 || chunkIndex < totalChunks - 3) return;
    prefetchNextChapterAudio(nextChapterId, nextChapterText, voice);
  }, [chunkIndex, totalChunks, nextChapterId, nextChapterText, voice]);

  // Auto-scroll active chunk into view
  useEffect(() => {
    if (showText && activeChunkRef.current) {
      activeChunkRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [chunkIndex, showText]);

  // On open, scroll the chapter list so the currently-playing chapter is
  // centered — scoped to the list's own scroll container (the virtualizer only
  // scrolls its element, never the page). One-shot per mount; rAF-deferred so
  // the container has laid out before measuring.
  useEffect(() => {
    if (chapterListScrolledRef.current || filteredChapters.length === 0) return;
    if (activeChapterListIndex < 0) return;
    const raf = requestAnimationFrame(() => {
      if (!chapterListRef.current) return;
      chapterRowVirtualizer.scrollToIndex(activeChapterListIndex, {
        align: "center",
      });
      chapterListScrolledRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [activeChapterListIndex, filteredChapters.length, chapterRowVirtualizer]);

  // On Android, the hardware back button should close the edit modal instead of
  // navigating away (which would discard unsaved edits). Capacitor dispatches a
  // 'backbutton' event on document before delegating to the Java activity.
  useEffect(() => {
    if (!showEditModal || !isNativePlatform()) return;
    const handler = (e: Event) => {
      e.preventDefault();
      setShowEditModal(false);
    };
    document.addEventListener("backbutton", handler);
    return () => document.removeEventListener("backbutton", handler);
  }, [showEditModal]);

  async function handleSaveOffline() {
    if (!chapterId || !chapterTextContent) return;
    setIsSaving(true);
    await cacheChapterText(chapterId, chapterTextContent);
    setIsCached(true);
    setCachedIds((prev) => new Set([...prev, chapterId!]));
    setIsSaving(false);
  }

  function handleOpenEdit() {
    setEditText(chapterTextContent ?? "");
    setEditError(null);
    setShowEditModal(true);
  }

  async function handleSaveEdit() {
    if (!chapterId) return;
    setIsSavingEdit(true);
    setEditError(null);
    try {
      await api.updateChapterText(chapterId, editText);
      // Update React Query cache so player uses new text immediately
      queryClient.setQueryData(["chapterText", chapterId], {
        id: chapterId,
        text_content: editText,
      });
      setShowEditModal(false);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Lỗi lưu văn bản");
    } finally {
      setIsSavingEdit(false);
    }
  }

  const latestRef = useRef({
    currentChapter,
    book,
    chapterText,
    isLoadingText,
    prevChapter,
    nextChapter,
    neighborChapters,
    listenProgress,
    autoPlay,
    navigateTo,
    voice,
    queryClient,
  });
  // Keep the ref current after every render (outside of render phase to satisfy
  // react-hooks/refs — useLayoutEffect runs synchronously before effects).
  useLayoutEffect(() => {
    latestRef.current = {
      currentChapter,
      book,
      chapterText,
      isLoadingText,
      prevChapter,
      nextChapter,
      neighborChapters,
      listenProgress,
      autoPlay,
      navigateTo,
      voice,
      queryClient,
    };
  });

  const bookDataId = book?.id ?? null;
  const chapterDataId = currentChapter?.id ?? null;
  const listenProgressValue = listenProgress?.progress_value ?? null;

  useEffect(() => {
    const {
      currentChapter,
      book,
      chapterText,
      isLoadingText,
      prevChapter,
      nextChapter,
      neighborChapters,
      listenProgress,
      autoPlay,
      navigateTo,
    } = latestRef.current;
    if (!currentChapter || !book) return;
    // autoPlayNextRef is set synchronously in onEnded before navigation so it
    // is always true when this effect fires after a chapter-advance, even if
    // searchParams hasn't updated yet (can lag on Capacitor static builds).
    const effectiveAutoPlay = autoPlay || autoPlayNextRef.current;
    autoPlayNextRef.current = false;
    setTrack({
      bookId,
      chapterId: chapterId!,
      chapter: currentChapter,
      book,
      text: chapterText?.text_content,
      isLoadingText,
      onPrev: prevChapter ? () => navigateTo(prevChapter) : null,
      onNext: nextChapter ? () => navigateTo(nextChapter) : null,
      onEnded: nextChapter
        ? (nativeChapterId?: string) => {
            if (nativeChapterId) {
              // Native TTS auto-advanced to this chapter. The queue effect will
              // fire for the new chapter and call mergeQueuedChapters() to
              // replenish the queue safely (skipping the in-flight chapter).
              autoPlayNextRef.current = true;
              // Only navigate if the user is currently on this book's listen
              // page. If they've navigated elsewhere (library, book detail,
              // reader, another book), leave them there — native TTS keeps
              // playing in the background and syncJsToNativeChapter will
              // reconcile the URL when they return to /listen.
              if (typeof window !== "undefined") {
                const pathname = window.location.pathname;
                const onListenPage = pathname.includes("/listen");
                const queryBookId = new URLSearchParams(
                  window.location.search,
                ).get("id");
                const onListenForThisBook =
                  onListenPage &&
                  (pathname.includes(bookId) || queryBookId === bookId);
                if (onListenForThisBook) {
                  router.push(
                    `/listen?id=${bookId}&chapter=${nativeChapterId}&autoplay=1`,
                  );
                }
              }
              return;
            }
            // native-tts-done path: queue is exhausted (or web TTS ended).
            const {
              voice: v,
              queryClient: qc,
              nextChapter: latestNext,
            } = latestRef.current;
            const target = latestNext ?? nextChapter;
            if (!target) return;
            // Backend voices only — native/browser engines don't use backend audio.
            if (
              target.id &&
              v &&
              !v.startsWith("native:") &&
              !v.startsWith("browser:")
            ) {
              const td = qc.getQueryData<{ text_content: string }>([
                "chapterText",
                target.id,
              ]);
              if (td?.text_content)
                prefetchNextChapterAudio(target.id, td.text_content, v);
            }
            autoPlayNextRef.current = true;
            // Same rule as the native auto-advance branch: only navigate if
            // the user is on this book's listen page. Otherwise let the
            // player keep advancing in the background.
            if (typeof window !== "undefined") {
              const pathname = window.location.pathname;
              const onListenPage = pathname.includes("/listen");
              const queryBookId = new URLSearchParams(
                window.location.search,
              ).get("id");
              const onListenForThisBook =
                onListenPage &&
                (pathname.includes(bookId) || queryBookId === bookId);
              if (onListenForThisBook) {
                navigateTo(target, true);
              }
            }
          }
        : undefined,
      neighborChapters,
      initialChunkIndex:
        listenProgress?.progress_value != null
          ? Math.floor(listenProgress.progress_value)
          : undefined,
      autoPlay: effectiveAutoPlay,
    });
  }, [
    bookId,
    chapterId,
    setTrack,
    bookDataId,
    chapterDataId,
    isLoadingText,
    listenProgressValue,
    router,
  ]);

  if (!chapterId) {
    return (
      <div className="text-center py-24 text-text-mute">
        Không có chương nào được chọn.{" "}
        <Link href={`/book?id=${bookId}`} className="text-accent underline">
          Quay lại
        </Link>
      </div>
    );
  }

  if (bookPending || chaptersPending) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="w-8 h-8 text-accent" />
      </div>
    );
  }

  if (!book || !currentChapter) {
    return (
      <div className="text-center py-24 text-text-mute">
        <p className="mb-2">
          {!book
            ? "Không thể tải thông tin sách."
            : "Không tìm thấy chương này."}
        </p>
        <p className="text-sm mb-4">
          Vui lòng kết nối mạng hoặc tải sách offline trước khi nghe.
        </p>
        <Link
          href={`/book?id=${bookId}`}
          className="text-accent underline text-sm"
        >
          Quay lại
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      {/* Top bar — design pattern: down-chevron close · "ĐANG NGHE · Chương N/Total" · text/read switch */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 mb-3">
        <Link
          href={`/book?id=${bookId}`}
          className="-ml-2 p-2 text-text hover:text-accent transition-colors"
          title={book.title}
          aria-label="Đóng trình phát"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 9l6 6 6-6"
            />
          </svg>
        </Link>
        <div className="text-center min-w-0">
          <p className="font-mono text-[9px] tracking-[0.2em] uppercase text-text-mute">
            Đang nghe
          </p>
          {currentChapter && (
            <p className="text-xs text-text-dim mt-0.5 truncate">
              Chương {currentChapter.chapter_index + 1} / {allChapters.length || "—"}
            </p>
          )}
        </div>
        <Link
          href={`/read?id=${bookId}&chapter=${chapterId}`}
          className="-mr-2 p-2 text-text hover:text-accent transition-colors"
          title="Chuyển sang đọc"
          aria-label="Chuyển sang đọc"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 6h16M4 12h16M4 18h10"
            />
          </svg>
        </Link>
      </div>

      {/* Player */}
      <SpeechPlayer />

      {/* Text panel toolbar */}
      {chapterTextContent && (
        <div className="flex items-center justify-between mt-4 mb-1">
          <button
            onClick={() => setShowText((v) => !v)}
            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
              showText
                ? "bg-accent/15 dark:bg-accent/15 border-accent/40 dark:border-accent/40 text-accent dark:text-accent"
                : "border-hairline-soft dark:border-hairline text-text-mute dark:text-text-mute hover:border-accent/40 hover:text-accent dark:hover:text-accent"
            }`}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 10h16M4 14h10"
              />
            </svg>
            {showText ? "Ẩn văn bản" : "Hiện văn bản"}
          </button>

          <button
            onClick={handleSaveOffline}
            disabled={isCached || isSaving || !chapterTextContent}
            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
              isCached
                ? "border-accent/40 dark:border-accent/40 text-accent dark:text-accent bg-accent/10 dark:bg-accent/30"
                : "border-hairline-soft dark:border-hairline text-text-mute dark:text-text-mute hover:border-accent/40 hover:text-accent dark:hover:text-accent disabled:opacity-40"
            }`}
          >
            {isSaving ? (
              <Spinner className="w-3 h-3" />
            ) : isCached ? (
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            ) : (
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
            )}
            {isCached ? "Đã lưu offline" : "Lưu offline"}
          </button>

          {isAdmin && (
            <button
              onClick={handleOpenEdit}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-hairline-soft dark:border-hairline text-text-mute dark:text-text-mute hover:border-amber-400 hover:text-gold dark:hover:text-gold transition-colors"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </svg>
              Sửa văn bản
            </button>
          )}
        </div>
      )}

      {/* Highlighted text view */}
      {showText && chunks.length > 0 && (
        <div className="mt-1 mb-4 max-h-72 overflow-y-auto rounded-xl border border-hairline-soft dark:border-hairline-soft bg-surface dark:bg-surface px-4 py-3 space-y-1.5 text-sm leading-relaxed">
          {chunks.map((chunk, i) => (
            <div
              key={i}
              ref={i === chunkIndex ? activeChunkRef : null}
              className={`rounded-lg px-2 py-1 transition-colors duration-300 ${
                i === chunkIndex
                  ? "bg-accent/15 dark:bg-accent/60 text-accent-dim dark:text-accent font-medium"
                  : i < chunkIndex
                    ? "text-text-mute dark:text-text-dim"
                    : "text-text-dim dark:text-text-mute"
              }`}
            >
              {chunk}
            </div>
          ))}
        </div>
      )}

      {/* Chapter list */}
      {allChapters.length > 1 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2 px-1">
            <p className="text-[11px] font-medium text-text-mute dark:text-text-mute uppercase tracking-wider">
              Danh sách chương
            </p>
            <span className="text-[11px] text-text-faint dark:text-text-dim tabular-nums">
              {allChapters.length} chương
            </span>
          </div>
          {/* Search box */}
          <div className="relative mb-2">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint dark:text-text-dim pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"
              />
            </svg>
            <input
              type="text"
              value={chapterSearch}
              onChange={(e) => setChapterSearch(e.target.value)}
              placeholder="Tìm chương..."
              className="w-full pl-8 pr-8 py-2 text-base rounded-lg border border-hairline-soft dark:border-hairline bg-surface dark:bg-raised text-text-dim dark:text-text-faint placeholder-text-faint dark:placeholder-text-faint focus:outline-none focus:border-accent/40 dark:focus:border-accent transition-colors"
            />
            {chapterSearch && (
              <button
                onClick={() => setChapterSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-faint dark:text-text-dim hover:text-text-mute dark:hover:text-text-mute transition-colors"
              >
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
          {/* Chapter rows (virtualized) */}
          <div
            ref={chapterListRef}
            className="max-h-60 overflow-y-auto rounded-xl border border-hairline-soft dark:border-hairline-soft"
          >
            {filteredChapters.length === 0 ? (
              <p className="px-4 py-4 text-xs text-text-mute dark:text-text-mute text-center">
                Không tìm thấy chương nào
              </p>
            ) : (
              <div
                style={{
                  height: chapterRowVirtualizer.getTotalSize(),
                  position: "relative",
                }}
              >
                {chapterRowVirtualizer.getVirtualItems().map((vi) => {
                  const ch = filteredChapters[vi.index];
                  const isActiveRow = ch.id === chapterId;
                  return (
                    <button
                      key={ch.id}
                      onClick={() => navigateTo(ch)}
                      style={{
                        height: vi.size,
                        transform: `translateY(${vi.start}px)`,
                      }}
                      className={`absolute left-0 top-0 w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center justify-between gap-2 select-none border-b border-hairline-soft dark:border-hairline-soft ${
                        isActiveRow
                          ? "bg-accent/15 dark:bg-accent/60 text-accent-dim dark:text-accent font-medium"
                          : "text-text-dim dark:text-text-mute hover:bg-ink dark:hover:bg-raised/60"
                      }`}
                    >
                      <span className="truncate">
                        <span className="text-[11px] font-mono text-text-faint dark:text-text-dim mr-2 tabular-nums">
                          {String(ch.chapter_index + 1).padStart(2, "0")}
                        </span>
                        {ch.title}
                      </span>
                      {isNative && cachedIds.has(ch.id) && (
                        <svg
                          className="w-3 h-3 shrink-0 text-accent dark:text-accent"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Edit chapter text modal */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-surface dark:bg-surface rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-hairline-soft dark:border-hairline-soft">
              <h2 className="text-sm font-semibold text-text dark:text-text">
                Sửa văn bản — {currentChapter?.title}
              </h2>
              <button
                onClick={() => setShowEditModal(false)}
                className="p-2 -mr-2 flex items-center justify-center text-text-mute hover:text-text-dim dark:hover:text-text-dim transition-colors"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <textarea
              className="flex-1 resize-none px-5 py-4 text-base text-text dark:text-text bg-transparent focus:outline-none font-mono leading-relaxed overflow-y-auto"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              spellCheck={false}
            />
            {editError && (
              <p className="px-5 py-2 text-xs text-vermillion">{editError}</p>
            )}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-hairline-soft dark:border-hairline-soft">
              <button
                onClick={() => setShowEditModal(false)}
                className="text-sm px-4 py-2 rounded-lg border border-hairline-soft dark:border-hairline text-text-dim dark:text-text-mute hover:bg-ink dark:hover:bg-raised transition-colors"
              >
                Hủy
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={isSavingEdit}
                className="text-sm px-4 py-2 rounded-lg bg-accent hover:bg-accent-dim disabled:opacity-50 text-white font-medium transition-colors flex items-center gap-2"
              >
                {isSavingEdit && <Spinner className="w-3.5 h-3.5" />}
                Lưu
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
