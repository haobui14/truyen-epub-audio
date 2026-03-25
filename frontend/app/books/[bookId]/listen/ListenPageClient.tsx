"use client";
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
import { api } from "@/lib/api";
import { isLoggedIn } from "@/lib/auth";
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
  saveLocalBookProgress,
  syncBookProgressToServer,
} from "@/lib/progressQueue";
import { useProgressSync } from "@/hooks/useProgressSync";
import { getUser } from "@/lib/auth";
import { prefetchNextChapterAudio } from "@/hooks/useSpeechPlayer";
import { getTtsBridge } from "@/lib/backgroundLock";
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
  const { data: chapterText, isLoading: isLoadingText } = useQuery({
    queryKey: ["chapterText", chapterId],
    queryFn: async () => {
      if (isNativePlatform()) {
        const cached = await getCachedChapterText(chapterId!);
        if (cached) return { id: chapterId!, text_content: cached };
      }
      try {
        return await api.getChapterText(chapterId!);
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
      try {
        const progress = await api.getBookProgress(bookId);
        if (progress?.chapter_id === chapterId) return progress;
        return null;
      } catch {
        const queued = await getLocalProgress(chapterId!);
        if (queued) {
          return {
            id: "",
            user_id: "",
            book_id: queued.book_id,
            chapter_id: queued.chapter_id,
            progress_value: queued.progress_value,
            total_value: queued.total_value,
            updated_at: new Date(queued.updated_at).toISOString(),
          };
        }
        return null;
      }
    },
    enabled: !!chapterId && isLoggedIn(),
  });

  const allChapters = useMemo(() => chaptersData?.items ?? [], [chaptersData]);
  const currentChapter = allChapters.find((c) => c.id === chapterId) ?? null;
  const currentIndex = currentChapter?.chapter_index ?? -1;

  const prevChapter =
    allChapters.find((c) => c.chapter_index === currentIndex - 1) ?? null;
  const nextChapter =
    allChapters.find((c) => c.chapter_index === currentIndex + 1) ?? null;

  // Preload adjacent chapter texts so navigation fires the player effect only once.
  // Includes offline fallback (IndexedDB) so queuing works even without network.
  const prevChapterId = prevChapter?.id ?? null;
  const nextChapterId = nextChapter?.id ?? null;
  useQuery({
    queryKey: ["chapterText", prevChapterId],
    queryFn: async () => {
      try {
        return await api.getChapterText(prevChapterId!);
      } catch {
        const cached = await getCachedChapterText(prevChapterId!);
        if (cached) return { id: prevChapterId!, text_content: cached };
        throw new Error("offline");
      }
    },
    enabled: !!prevChapterId,
    staleTime: Infinity,
  });
  const { data: nextChapterTextData } = useQuery({
    queryKey: ["chapterText", nextChapterId],
    queryFn: async () => {
      try {
        return await api.getChapterText(nextChapterId!);
      } catch {
        const cached = await getCachedChapterText(nextChapterId!);
        if (cached) return { id: nextChapterId!, text_content: cached };
        throw new Error("offline");
      }
    },
    enabled: !!nextChapterId,
    staleTime: Infinity,
  });

  const neighborChapters = [-2, -1, 0, 1, 2]
    .map((offset) =>
      allChapters.find((c) => c.chapter_index === currentIndex + offset),
    )
    .filter(
      (c): c is NonNullable<typeof c> =>
        !!c && c.id !== chapterId && c.status === "ready",
    )
    .concat(currentChapter?.status === "ready" ? [currentChapter] : [])
    .map((c) => ({ id: c.id }));

  const navigateTo = useCallback(
    (chapter: typeof currentChapter, autoplay = false) => {
      if (chapter) {
        const url = `/listen?id=${bookId}&chapter=${chapter.id}${autoplay ? "&autoplay=1" : ""}`;
        router.push(url);
      }
    },
    [bookId, router],
  );

  const queryClient = useQueryClient();
  const { setTrack, chunkIndex, totalChunks, voice, rate, pitch, isPlaying } =
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
  const activeChapterRef = useRef<HTMLButtonElement>(null);
  const chapterListScrolledRef = useRef(false);

  // Tracks whether the current chapter navigation was triggered by auto-advance
  // (onEnded) vs. manual user action. When true, the queue effect skips clearing
  // and rebuilding the native queue since it's already populated.
  const wasAutoAdvanceRef = useRef(false);

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

  // ── Sync JS with native service on app resume (screen on / tab visible) ──
  // When the WebView is suspended (screen off), native auto-advances chapters
  // but JS events don't fire. On resume, check what native is actually playing
  // and navigate to it if it differs from the current JS chapter.
  // Also save every chapter played to local DB and trigger server sync.
  useEffect(() => {
    if (!voice.startsWith("native:")) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const bridge = getTtsBridge();
      if (!bridge || typeof bridge.getCurrentChapterId !== "function") return;
      const nativeChapterId = bridge.getCurrentChapterId();
      if (nativeChapterId && nativeChapterId !== chapterId) {
        // Native advanced to a different chapter — save it to local DB first
        const targetChapter = allChapters.find((c) => c.id === nativeChapterId);
        if (targetChapter) {
          const nativeChunk = bridge.getCurrentChunk();
          saveLocalBookProgress({
            book_id: bookId,
            chapter_id: nativeChapterId,
            chapter_index: targetChapter.chapter_index,
            progress_value: nativeChunk >= 0 ? nativeChunk : 0,
          });

          localStorage.setItem(`listen-chapter:${bookId}`, nativeChapterId);
          syncBookProgressToServer(bookId).catch(() => {});

          const nativePlaying = bridge.isPlaying();
          const url = `/listen?id=${bookId}&chapter=${nativeChapterId}${nativePlaying ? "&autoplay=1" : ""}`;
          router.replace(url);
        }
      } else {
        // Same chapter or no native chapter — still sync to server
        syncBookProgressToServer(bookId).catch(() => {});
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [voice, chapterId, bookId, allChapters, router]);

  // ── Initial native sync on cold start ──
  // visibilitychange only fires on state *transitions*. If the OS killed the
  // WebView while TtsPlaybackService kept running, the document is already
  // visible when the page reloads and no visibilitychange event fires.
  // Run the same sync logic once, as soon as allChapters finishes loading.
  useEffect(() => {
    if (!voice.startsWith("native:") || allChapters.length === 0) return;
    if (nativeInitSyncDoneRef.current) return;
    nativeInitSyncDoneRef.current = true;

    const bridge = getTtsBridge();
    if (!bridge || typeof bridge.getCurrentChapterId !== "function") return;
    const nativeChapterId = bridge.getCurrentChapterId();
    if (!nativeChapterId || nativeChapterId === chapterId) return;

    const targetChapter = allChapters.find((c) => c.id === nativeChapterId);
    if (!targetChapter) return;

    const nativeChunk = bridge.getCurrentChunk();
    saveLocalBookProgress({
      book_id: bookId,
      chapter_id: nativeChapterId,
      chapter_index: targetChapter.chapter_index,
      progress_value: nativeChunk >= 0 ? nativeChunk : 0,
    });
    localStorage.setItem(`listen-chapter:${bookId}`, nativeChapterId);
    syncBookProgressToServer(bookId).catch(() => {});

    const nativePlaying = bridge.isPlaying();
    router.replace(
      `/listen?id=${bookId}&chapter=${nativeChapterId}${
        nativePlaying ? "&autoplay=1" : ""
      }`,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, allChapters, bookId, chapterId, router]);

  // ── Native TTS: queue cached chapters in the Java service ──
  // Queues all chapters whose text is already in React Query / IndexedDB.
  // Uncached chapters are handled later: when the queue runs out, native fires
  // native-tts-done and JS navigates to the next chapter.
  const nextChapterText = nextChapterTextData?.text_content ?? null;
  useEffect(() => {
    if (
      !voice.startsWith("native:") ||
      allChapters.length === 0 ||
      currentIndex < 0
    )
      return;
    const bridge = getTtsBridge();
    if (!bridge) return;

    // When the chapter changed via auto-advance (onEnded), the native service
    // already has the remaining chapters queued. Clearing and re-queueing
    // creates a window where the queue is empty, causing premature "done"
    // events and cascading chapter skips.
    if (wasAutoAdvanceRef.current) {
      wasAutoAdvanceRef.current = false;
      return;
    }

    // Do NOT call clearNextChapter() here. queueAllChapters() replaces the
    // queue atomically, so a prior explicit clear creates a race window where
    // the queue is empty. If native finishes the last queued chapter during
    // that window it fires native-tts-done and the player stops.

    // Gather the next chapters after the current one.
    // Capped at 10 to prevent native from auto-playing hundreds of chapters
    // in the background while the screen is off, which would cause large
    // chapter jumps (e.g. 541 → 648) when the user resumes.
    const remainingChapters = allChapters
      .filter((c) => c.chapter_index > currentIndex)
      .sort((a, b) => a.chapter_index - b.chapter_index)
      .slice(0, 10);

    if (remainingChapters.length === 0) return;

    let cancelled = false;

    (async () => {
      type QueueItem = {
        chunks: string[];
        chapterId: string;
        title: string;
        rate: number;
        pitch: number;
      };
      const chunkMap = new Map<string, string[]>();

      // Collect chapters already in React Query cache or IndexedDB
      for (const ch of remainingChapters) {
        let text: string | null = null;
        const cached = queryClient.getQueryData<{ text_content: string }>([
          "chapterText",
          ch.id,
        ]);
        if (cached?.text_content) {
          text = cached.text_content;
        } else {
          try {
            text = await getCachedChapterText(ch.id);
          } catch {
            /* not in IndexedDB */
          }
        }
        if (text) {
          const chunks = splitChunks(text);
          if (chunks.length > 0) chunkMap.set(ch.id, chunks);
        }
      }

      if (cancelled) return;

      // Helper: build an ordered queue from whatever is in chunkMap
      const buildQueue = (): QueueItem[] =>
        remainingChapters
          .filter((ch) => chunkMap.has(ch.id))
          .map((ch) => ({
            chunks: chunkMap.get(ch.id)!,
            chapterId: ch.id,
            title: ch.title ?? "Đang phát...",
            rate,
            pitch,
          }));

      // Phase 1: send immediately available chapters so native can start
      // auto-advancing without waiting for the full fetch below.
      const initialQueue = buildQueue();
      if (initialQueue.length > 0) {
        bridge.queueAllChapters(JSON.stringify(initialQueue));
      }

      // Phase 2: fetch uncached chapters from API and queue each one as soon
      // as its text arrives. This ensures the native service always has the
      // next chapter ready before the current one finishes, so it can
      // auto-advance in the background without needing a JS round-trip.
      // Do NOT gate on navigator.onLine — it is unreliable in Capacitor's
      // WebView (returns false even when connected). Let each fetch fail
      // naturally; the catch block already handles network errors gracefully.
      const uncached = remainingChapters.filter((ch) => !chunkMap.has(ch.id));
      let queuedLen = initialQueue.length;
      for (const ch of uncached) {
        if (cancelled) break;
        try {
          const data = await api.getChapterText(ch.id);
          if (data?.text_content) {
            queryClient.setQueryData(["chapterText", ch.id], data);
            const chunks = splitChunks(data.text_content);
            if (chunks.length > 0) {
              chunkMap.set(ch.id, chunks);
              // Queue immediately — don't wait for all chapters to be fetched.
              const q = buildQueue();
              if (!cancelled && q.length > queuedLen) {
                bridge.queueAllChapters(JSON.stringify(q));
                queuedLen = q.length;
              }
            }
          }
        } catch {
          /* offline or API error — skip */
        }
      }

      if (cancelled) return;

      // Safety net: ensure the final queue state is registered in case the
      // last incremental update was skipped due to ordering.
      const finalQueue = buildQueue();
      if (finalQueue.length > queuedLen) {
        bridge.queueAllChapters(JSON.stringify(finalQueue));
      }
    })();

    return () => {
      cancelled = true;
    };
    // nextChapterText intentionally excluded: it changes async when adjacent chapter
    // text loads, which would re-fire this effect and clear the native queue mid-play,
    // causing premature "done" events and chapter cascade skips.
  }, [chapterId, voice, rate, pitch, allChapters, currentIndex, queryClient, isPlaying]);

  // ── Web streaming: prefetch first TTS audio chunks when near end ──
  useEffect(() => {
    if (!nextChapterId || !nextChapterText || voice.startsWith("native:"))
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

  // Auto-scroll chapter list to the active chapter on first render
  useEffect(() => {
    if (!chapterListScrolledRef.current && activeChapterRef.current) {
      chapterListScrolledRef.current = true;
      activeChapterRef.current.scrollIntoView({ block: "center" });
    }
  }, [chapterId, allChapters]);

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
              // Native TTS passed its actual current chapter (via chapter-advance
              // event — queue still has chapters). Set flag so the queue effect
              // skips clearing/rebuilding the existing native queue.
              wasAutoAdvanceRef.current = true;
              autoPlayNextRef.current = true;
              router.push(
                `/listen?id=${bookId}&chapter=${nativeChapterId}&autoplay=1`,
              );
              return;
            }
            // native-tts-done path: queue is exhausted (or web TTS ended).
            // Do NOT set wasAutoAdvanceRef — the queue is empty and must be
            // rebuilt for the next chapter.
            const {
              voice: v,
              queryClient: qc,
              nextChapter: latestNext,
            } = latestRef.current;
            const target = latestNext ?? nextChapter;
            if (!target) return;
            if (target.id && v && !v.startsWith("native:")) {
              const td = qc.getQueryData<{ text_content: string }>([
                "chapterText",
                target.id,
              ]);
              if (td?.text_content)
                prefetchNextChapterAudio(target.id, td.text_content, v);
            }
            autoPlayNextRef.current = true;
            navigateTo(target, true);
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
      <div className="text-center py-24 text-gray-500">
        Không có chương nào được chọn.{" "}
        <Link href={`/book?id=${bookId}`} className="text-indigo-600 underline">
          Quay lại
        </Link>
      </div>
    );
  }

  if (bookPending || chaptersPending) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="w-8 h-8 text-indigo-600" />
      </div>
    );
  }

  if (!book || !currentChapter) {
    return (
      <div className="text-center py-24 text-gray-500">
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
          className="text-indigo-600 underline text-sm"
        >
          Quay lại
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-4">
        <Link
          href={`/book?id=${bookId}`}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          <span className="hidden sm:inline truncate max-w-48">
            {book.title}
          </span>
          <span className="sm:hidden">Quay lại</span>
        </Link>
        <Link
          href={`/read?id=${bookId}&chapter=${chapterId}`}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors flex items-center gap-1"
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
              d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
            />
          </svg>
          Đọc
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
                ? "bg-indigo-50 dark:bg-indigo-950 border-indigo-300 dark:border-indigo-700 text-indigo-600 dark:text-indigo-400"
                : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400"
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
                ? "border-emerald-300 dark:border-emerald-700 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30"
                : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-40"
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
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-amber-400 hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
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
        <div className="mt-1 mb-4 max-h-72 overflow-y-auto rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3 space-y-1.5 text-sm leading-relaxed">
          {chunks.map((chunk, i) => (
            <div
              key={i}
              ref={i === chunkIndex ? activeChunkRef : null}
              className={`rounded-lg px-2 py-1 transition-colors duration-300 ${
                i === chunkIndex
                  ? "bg-indigo-100 dark:bg-indigo-900/60 text-indigo-900 dark:text-indigo-100 font-medium"
                  : i < chunkIndex
                    ? "text-gray-400 dark:text-gray-600"
                    : "text-gray-600 dark:text-gray-400"
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
            <p className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
              Danh sách chương
            </p>
            <span className="text-[11px] text-gray-300 dark:text-gray-600 tabular-nums">
              {allChapters.length} chương
            </span>
          </div>
          {/* Search box */}
          <div className="relative mb-2">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 dark:text-gray-600 pointer-events-none"
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
              className="w-full pl-8 pr-8 py-2 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none focus:border-indigo-400 dark:focus:border-indigo-600 transition-colors"
            />
            {chapterSearch && (
              <button
                onClick={() => setChapterSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 transition-colors"
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
          {/* Chapter rows */}
          {(() => {
            const q = chapterSearch.trim().toLowerCase();
            const filtered = q
              ? allChapters.filter(
                  (ch) =>
                    ch.title.toLowerCase().includes(q) ||
                    String(ch.chapter_index + 1).includes(q),
                )
              : allChapters;
            return (
              <div className="max-h-60 overflow-y-auto rounded-xl border border-gray-100 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
                {filtered.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-gray-400 dark:text-gray-500 text-center">
                    Không tìm thấy chương nào
                  </p>
                ) : (
                  filtered.map((ch) => (
                    <button
                      key={ch.id}
                      ref={ch.id === chapterId ? activeChapterRef : null}
                      onClick={() => navigateTo(ch)}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center justify-between gap-2 ${
                        ch.id === chapterId
                          ? "bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-medium"
                          : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60"
                      }`}
                    >
                      <span>
                        <span className="text-[11px] font-mono text-gray-300 dark:text-gray-600 mr-2 tabular-nums">
                          {String(ch.chapter_index + 1).padStart(2, "0")}
                        </span>
                        {ch.title}
                      </span>
                      {isNativePlatform() && cachedIds.has(ch.id) && (
                        <svg
                          className="w-3 h-3 shrink-0 text-emerald-400 dark:text-emerald-500"
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
                  ))
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Edit chapter text modal */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
              <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                Sửa văn bản — {currentChapter?.title}
              </h2>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
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
              className="flex-1 resize-none px-5 py-4 text-sm text-gray-800 dark:text-gray-100 bg-transparent focus:outline-none font-mono leading-relaxed overflow-y-auto"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              spellCheck={false}
            />
            {editError && (
              <p className="px-5 py-2 text-xs text-red-500">{editError}</p>
            )}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 dark:border-gray-800">
              <button
                onClick={() => setShowEditModal(false)}
                className="text-sm px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Hủy
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={isSavingEdit}
                className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium transition-colors flex items-center gap-2"
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
