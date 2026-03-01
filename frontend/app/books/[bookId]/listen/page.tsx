"use client";
import { use, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isLoggedIn } from "@/lib/auth";
import { SpeechPlayer } from "@/components/player/SpeechPlayer";
import { Spinner } from "@/components/ui/Spinner";
import { usePlayerContext } from "@/context/PlayerContext";

export default function ListenPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = use(params);
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
    queryFn: () => api.getBookChapters(bookId, 1, 5000),
  });

  // Fetch text for the current chapter only
  const { data: chapterText, isLoading: isLoadingText } = useQuery({
    queryKey: ["chapterText", chapterId],
    queryFn: () => api.getChapterText(chapterId!),
    enabled: !!chapterId,
    staleTime: Infinity,
  });

  // Fetch saved listening progress
  const { data: listenProgress } = useQuery({
    queryKey: ["progress", chapterId, "listen"],
    queryFn: () => api.getChapterProgress(chapterId!, "listen"),
    enabled: !!chapterId && isLoggedIn(),
  });

  const allChapters = chaptersData?.items ?? [];
  const currentChapter = allChapters.find((c) => c.id === chapterId) ?? null;
  const currentIndex = currentChapter?.chapter_index ?? -1;

  const prevChapter =
    allChapters.find((c) => c.chapter_index === currentIndex - 1) ?? null;
  const nextChapter =
    allChapters.find((c) => c.chapter_index === currentIndex + 1) ?? null;

  // Preload adjacent chapter texts so navigation fires the player effect only once
  // (text is already in cache when chapterId changes → no double-fire / gap)
  const prevChapterId = prevChapter?.id ?? null;
  const nextChapterId = nextChapter?.id ?? null;
  useQuery({
    queryKey: ["chapterText", prevChapterId],
    queryFn: () => api.getChapterText(prevChapterId!),
    enabled: !!prevChapterId,
    staleTime: Infinity,
  });
  useQuery({
    queryKey: ["chapterText", nextChapterId],
    queryFn: () => api.getChapterText(nextChapterId!),
    enabled: !!nextChapterId,
    staleTime: Infinity,
  });

  // Chapters to pre-download for offline: current ±2, only those with audio already generated.
  // Restricting to status=="ready" avoids triggering slow on-the-fly TTS generation
  // for chapters that haven't been converted yet.
  // Neighbors (±1, ±2) are iterated first so they're ready when the user navigates forward/back;
  // current chapter is appended last since it's already streaming.
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

  const { setTrack } = usePlayerContext();

  // Keep a ref of all volatile values so the useEffect below never has
  // object/array identity in its dependency list (prevents infinite loops).
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
  };

  // Stable primitive IDs — change from null→string when React Query data
  // arrives, which re-fires the effect after a hard page reload.
  const bookDataId = book?.id ?? null;
  const chapterDataId = currentChapter?.id ?? null;
  // Stable dep for listenProgress so setTrack re-fires when progress loads late
  const listenProgressValue = listenProgress?.progress_value ?? null;

  // Sync current track into the global PlayerContext so the MiniPlayer
  // keeps playing even when the user navigates to a different route.
  // Deps are stable primitives only — volatile values are read from the ref.
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
      onEnded: nextChapter ? () => navigateTo(nextChapter, true) : undefined,
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
