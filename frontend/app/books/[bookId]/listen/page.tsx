"use client";
import { use, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SpeechPlayer } from "@/components/player/SpeechPlayer";
import { Spinner } from "@/components/ui/Spinner";

export default function ListenPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = use(params);
  const searchParams = useSearchParams();
  const chapterId = searchParams.get("chapter");
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
  });

  const allChapters = chaptersData?.items ?? [];
  const currentChapter = allChapters.find((c) => c.id === chapterId) ?? null;
  const currentIndex = currentChapter?.chapter_index ?? -1;

  // All chapters are navigable — speech reads any chapter instantly
  const prevChapter = allChapters.find((c) => c.chapter_index === currentIndex - 1) ?? null;
  const nextChapter = allChapters.find((c) => c.chapter_index === currentIndex + 1) ?? null;

  const navigateTo = useCallback(
    (chapter: typeof currentChapter) => {
      if (chapter) router.push(`/books/${bookId}/listen?chapter=${chapter.id}`);
    },
    [bookId, router]
  );

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
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          <span className="hidden sm:inline">{book.title}</span>
          <span className="sm:hidden">Quay lại</span>
        </Link>
        <Link
          href={`/books/${bookId}/read?chapter=${chapterId}`}
          className="flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-950 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          Đọc
        </Link>
      </div>

      {/* Player */}
      <SpeechPlayer
        chapter={currentChapter}
        book={book}
        text={chapterText?.text_content}
        isLoadingText={isLoadingText}
        onPrev={prevChapter ? () => navigateTo(prevChapter) : null}
        onNext={nextChapter ? () => navigateTo(nextChapter) : null}
      />

      {/* Chapter list */}
      {allChapters.length > 1 && (
        <div className="mt-8">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2 px-1">
            Các chương
          </p>
          <div className="max-h-64 overflow-y-auto rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 divide-y divide-gray-100 dark:divide-gray-700 scrollbar-thin">
            {allChapters.map((ch) => (
              <button
                key={ch.id}
                onClick={() => navigateTo(ch)}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                  ch.id === chapterId
                    ? "bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-medium"
                    : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                }`}
              >
                <span className="text-xs font-mono text-gray-400 dark:text-gray-500 mr-2">{ch.chapter_index + 1}.</span>
                {ch.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
