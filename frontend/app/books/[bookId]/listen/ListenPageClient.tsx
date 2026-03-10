"use client";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
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
} from "@/lib/chapterTextCache";
import { getLocalProgress } from "@/lib/progressQueue";
import { useProgressSync } from "@/hooks/useProgressSync";
import { prefetchNextChapterAudio } from "@/hooks/useSpeechPlayer";
import { getTtsBridge } from "@/lib/backgroundLock";
import { splitIntoChunks as splitChunks } from "@/lib/textChunks";

export default function ListenPage() {
  const bookId = usePathname().split("/")[2];
  const searchParams = useSearchParams();
  const chapterId = searchParams.get("chapter");
  const autoPlay = searchParams.get("autoplay") === "1";
  const router = useRouter();

  const { data: book } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
  });

  const { data: chaptersData } = useQuery({
    queryKey: ["chapters", bookId, "all"],
    queryFn: () => api.getAllBookChapters(bookId),
  });

  // Fetch text for the current chapter — falls back to IndexedDB cache when offline
  const { data: chapterText, isLoading: isLoadingText } = useQuery({
    queryKey: ["chapterText", chapterId],
    queryFn: async () => {
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

  // Fetch saved listening progress — falls back to offline queue
  const { data: listenProgress } = useQuery({
    queryKey: ["progress", chapterId, "listen"],
    queryFn: async () => {
      try {
        return await api.getChapterProgress(chapterId!, "listen");
      } catch {
        const queued = await getLocalProgress(chapterId!, "listen");
        if (queued) {
          return {
            id: "",
            user_id: "",
            book_id: queued.book_id,
            chapter_id: queued.chapter_id,
            progress_type: queued.progress_type,
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

  const allChapters = chaptersData?.items ?? [];
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
        const url = `/books/${bookId}/listen?chapter=${chapter.id}${autoplay ? "&autoplay=1" : ""}`;
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
    progressType: "listen",
  });

  // Save listen progress whenever the chunk index advances.
  // Skip on chapter change: chunkIndex/totalChunks may still be stale from
  // the previous chapter, which would save wrong progress and cause a cascade
  // where the player skips ahead many chapters on the next session.
  const settledChapterRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chapterId || totalChunks === 0) return;
    if (settledChapterRef.current !== chapterId) {
      settledChapterRef.current = chapterId;
      return; // Wait for first real chunk update before reporting
    }
    reportProgress(chunkIndex, totalChunks);
  }, [chapterId, chunkIndex, totalChunks, reportProgress]);

  const [isCached, setIsCached] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showText, setShowText] = useState(false);
  const activeChunkRef = useRef<HTMLDivElement>(null);
  const activeChapterRef = useRef<HTMLButtonElement>(null);
  const chapterListScrolledRef = useRef(false);

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

  // ── Sync JS with native service on app resume (screen on / tab visible) ──
  // When the WebView is suspended (screen off), native auto-advances chapters
  // but JS events don't fire. On resume, check what native is actually playing
  // and navigate to it if it differs from the current JS chapter.
  useEffect(() => {
    if (!voice.startsWith("native:")) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const bridge = getTtsBridge();
      if (!bridge || typeof bridge.getCurrentChapterId !== "function") return;
      const nativeChapterId = bridge.getCurrentChapterId();
      if (nativeChapterId && nativeChapterId !== chapterId) {
        // Native advanced to a different chapter — navigate to it
        const targetChapter = allChapters.find((c) => c.id === nativeChapterId);
        if (targetChapter) {
          const nativePlaying = bridge.isPlaying();
          const url = `/books/${bookId}/listen?chapter=${nativeChapterId}${nativePlaying ? "&autoplay=1" : ""}`;
          router.replace(url);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [voice, chapterId, bookId, allChapters, router]);

  // ── Native TTS: queue ALL remaining chapters in the Java service ──
  // When the current chapter starts playing on native TTS, we fetch all
  // remaining chapters' text and queue them so the service can play
  // through the entire book with screen off.
  const nextChapterText = nextChapterTextData?.text_content ?? null;
  useEffect(() => {
    if (!voice.startsWith("native:") || allChapters.length === 0 || currentIndex < 0) return;
    const bridge = getTtsBridge();
    if (!bridge) return;

    // Clear old queue first
    bridge.clearNextChapter();

    // Gather all chapters after the current one
    const remainingChapters = allChapters
      .filter((c) => c.chapter_index > currentIndex)
      .sort((a, b) => a.chapter_index - b.chapter_index);

    if (remainingChapters.length === 0) return;

    let cancelled = false;

    (async () => {
      // Phase 1: immediately queue chapters whose text is already cached
      const cachedToQueue: { chunks: string[]; chapterId: string; title: string; rate: number; pitch: number }[] = [];
      const uncachedChapters: typeof remainingChapters = [];

      for (const ch of remainingChapters) {
        let text: string | null = null;
        const cached = queryClient.getQueryData<{ text_content: string }>(["chapterText", ch.id]);
        if (cached?.text_content) {
          text = cached.text_content;
        } else {
          try {
            text = await getCachedChapterText(ch.id);
          } catch {
            // not in IndexedDB
          }
        }
        if (text) {
          const chunks = splitChunks(text);
          if (chunks.length > 0) {
            cachedToQueue.push({
              chunks,
              chapterId: ch.id,
              title: ch.title ?? "Đang phát...",
              rate,
              pitch,
            });
          }
        } else {
          uncachedChapters.push(ch);
        }
      }

      if (cancelled) return;
      if (cachedToQueue.length > 0) {
        bridge.queueAllChapters(JSON.stringify(cachedToQueue));
      }

      // Phase 2: fetch uncached chapters from API and add to queue individually.
      // Each chapter is available to the native service as soon as it's fetched,
      // so playback continues even if the WebView suspends mid-fetch.
      for (const ch of uncachedChapters) {
        if (cancelled) break;
        try {
          const data = await api.getChapterText(ch.id);
          if (data?.text_content) {
            queryClient.setQueryData(["chapterText", ch.id], data);
            const chunks = splitChunks(data.text_content);
            if (chunks.length > 0) {
              bridge.queueNextChapter(
                JSON.stringify(chunks),
                ch.id,
                ch.title ?? "Đang phát...",
                rate,
                pitch,
              );
            }
          }
        } catch {
          // API fetch failed (offline?) — skip this chapter
        }
      }
    })();

    return () => { cancelled = true; };
  }, [chapterId, voice, rate, pitch, allChapters, currentIndex, queryClient, nextChapterText]);

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
    setIsSaving(false);
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
        ? () => {
            // Pre-fetch next chapter audio before navigation starts (safety net)
            const { voice: v, queryClient: qc } = latestRef.current;
            if (nextChapter.id && v && !v.startsWith("native:")) {
              const td = qc.getQueryData<{ text_content: string }>([
                "chapterText",
                nextChapter.id,
              ]);
              if (td?.text_content)
                prefetchNextChapterAudio(nextChapter.id, td.text_content, v);
            }
            navigateTo(nextChapter, true);
          }
        : undefined,
      neighborChapters,
      initialChunkIndex:
        listenProgress?.progress_value != null
          ? Math.floor(listenProgress.progress_value)
          : undefined,
      autoPlay,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bookId,
    chapterId,
    setTrack,
    bookDataId,
    chapterDataId,
    isLoadingText,
    listenProgressValue,
  ]);

  if (!chapterId) {
    return (
      <div className="text-center py-24 text-gray-500">
        Không có chương nào được chọn.{" "}
        <Link href={`/books/${bookId}`} className="text-indigo-600 underline">
          Quay lại
        </Link>
      </div>
    );
  }

  if (!currentChapter || !book) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="w-8 h-8 text-indigo-600" />
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-4">
        <Link
          href={`/books/${bookId}`}
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
          href={`/books/${bookId}/read?chapter=${chapterId}`}
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
          <p className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2 px-1">
            Danh sách chương
          </p>
          <div className="max-h-60 overflow-y-auto rounded-xl border border-gray-100 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
            {allChapters.map((ch) => (
              <button
                key={ch.id}
                ref={ch.id === chapterId ? activeChapterRef : null}
                onClick={() => navigateTo(ch)}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                  ch.id === chapterId
                    ? "bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-medium"
                    : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60"
                }`}
              >
                <span className="text-[11px] font-mono text-gray-300 dark:text-gray-600 mr-2 tabular-nums">
                  {String(ch.chapter_index + 1).padStart(2, "0")}
                </span>
                {ch.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
