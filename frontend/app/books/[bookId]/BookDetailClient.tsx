"use client";
import { use, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isLoggedIn } from "@/lib/auth";
import { ChapterList } from "@/components/books/ChapterList";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";

export default function BookDetailPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = use(params);
  const [page, setPage] = useState(1);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteBook(bookId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      router.push("/");
    },
  });

  const { data: book, isLoading: bookLoading } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "parsing" ? 2000 : false;
    },
  });

  const { data: chaptersData, isLoading: chaptersLoading } = useQuery({
    queryKey: ["chapters", bookId, page],
    queryFn: () => api.getBookChapters(bookId, page),
    enabled: !!book && book.status !== "pending" && book.status !== "parsing",
  });

  // Fetch last-accessed chapter per mode so buttons resume where user left off
  const { data: listenProgressList } = useQuery({
    queryKey: ["bookProgress", bookId, "listen"],
    queryFn: () => api.getBookProgress(bookId, "listen"),
    enabled: !!book && isLoggedIn(),
  });
  const { data: readProgressList } = useQuery({
    queryKey: ["bookProgress", bookId, "read"],
    queryFn: () => api.getBookProgress(bookId, "read"),
    enabled: !!book && isLoggedIn(),
  });

  if (bookLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="w-8 h-8 text-indigo-600" />
      </div>
    );
  }

  if (!book) {
    return (
      <div className="text-center py-24">
        <svg
          className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
          />
        </svg>
        <p className="text-gray-500 dark:text-gray-400 font-medium">
          Không tìm thấy truyện
        </p>
        <Link
          href="/"
          className="text-sm text-indigo-600 hover:text-indigo-700 mt-2 inline-block"
        >
          Quay lại thư viện
        </Link>
      </div>
    );
  }

  const isParsing = book.status === "pending" || book.status === "parsing";
  const chapters = chaptersData?.items ?? [];
  const firstChapter = chapters[0] ?? null;

  // Most-recently-updated progress entry for each mode
  const sortByRecent = (list: typeof listenProgressList) =>
    list?.slice().sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0] ?? null;
  const lastListenEntry = sortByRecent(listenProgressList);
  const lastReadEntry   = sortByRecent(readProgressList);

  const listenChapterId = lastListenEntry?.chapter_id ?? firstChapter?.id;
  const readChapterId   = lastReadEntry?.chapter_id   ?? firstChapter?.id;
  const hasListenProgress = !!lastListenEntry;
  const hasReadProgress   = !!lastReadEntry;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <nav className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 min-w-0">
          <Link
            href="/"
            className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors shrink-0"
          >
            Thư viện
          </Link>
          <svg
            className="w-3.5 h-3.5 shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
          <span className="text-gray-900 dark:text-gray-100 font-medium truncate max-w-xs">
            {book.title}
          </span>
        </div>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="shrink-0 ml-3 p-2 rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
          title="Xóa truyện"
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
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      </nav>

      {/* Book header card */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm overflow-hidden mb-6">
        <div className="flex gap-5 sm:gap-6 p-5 sm:p-6">
          <div className="w-28 sm:w-32 h-40 sm:h-44 rounded-xl overflow-hidden bg-linear-to-br from-indigo-50 to-purple-50 dark:from-indigo-950 dark:to-purple-950 shrink-0 shadow-md">
            {book.cover_url ? (
              <Image
                src={book.cover_url}
                alt={book.title}
                width={128}
                height={176}
                className="object-cover w-full h-full"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-indigo-200 dark:text-indigo-800">
                <svg
                  className="w-14 h-14"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                  />
                </svg>
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex-1">
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1.5 leading-tight">
                {book.title}
              </h1>
              {book.author && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                  {book.author}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400 dark:text-gray-500 mb-3">
                {book.total_chapters > 0 && (
                  <span className="flex items-center gap-1">
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
                        d="M4 6h16M4 12h16M4 18h7"
                      />
                    </svg>
                    {book.total_chapters} chương
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        {isParsing ? (
          <div className="flex items-center gap-3 mx-5 sm:mx-6 mb-5 sm:mb-6 px-4 py-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50">
            <Spinner className="w-5 h-5 text-amber-500 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                Đang xử lý file EPUB...
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
                Sẽ sẵn sàng trong giây lát
              </p>
            </div>
          </div>
        ) : firstChapter ? (
          <div className="grid grid-cols-2 gap-3 mx-5 sm:mx-6 mb-5 sm:mb-6">
            <Link
              href={listenChapterId ? `/books/${bookId}/listen?chapter=${listenChapterId}` : "#"}
              className="flex items-center gap-3 px-4 py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 transition-colors text-white group"
            >
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0 group-hover:bg-white/30 transition-colors">
                <svg
                  className="w-5 h-5 ml-0.5"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-sm">
                  {hasListenProgress ? "Nghe tiếp" : "Nghe ngay"}
                </p>
                <p className="text-[11px] text-indigo-200 mt-0.5">
                  {hasListenProgress ? "Tiếp tục từ chỗ dừng" : "TTS trực tiếp"}
                </p>
              </div>
            </Link>
            <Link
              href={readChapterId ? `/books/${bookId}/read?chapter=${readChapterId}` : "#"}
              className="flex items-center gap-3 px-4 py-3.5 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-800 dark:text-gray-200 group"
            >
              <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-600 flex items-center justify-center shrink-0 group-hover:bg-gray-300 dark:group-hover:bg-gray-500 transition-colors">
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
                    d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                  />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-sm">
                  {hasReadProgress ? "Đọc tiếp" : "Đọc truyện"}
                </p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                  {hasReadProgress ? "Tiếp tục từ chỗ dừng" : "Đọc văn bản"}
                </p>
              </div>
            </Link>
          </div>
        ) : null}
      </div>

      {/* Chapter list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Danh sách chương
          </h2>
          {chaptersData && (
            <span className="text-xs font-medium text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2.5 py-1 rounded-full">
              {chaptersData.total} chương
            </span>
          )}
        </div>
        {chaptersLoading ? (
          <div className="flex justify-center py-12">
            <Spinner className="w-6 h-6 text-indigo-600" />
          </div>
        ) : (
          <ChapterList
            chapters={chapters}
            bookId={bookId}
            page={chaptersData?.page ?? 1}
            totalPages={chaptersData?.total_pages ?? 1}
            total={chaptersData?.total ?? 0}
            onPageChange={setPage}
          />
        )}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Xóa truyện?"
        message={`Bạn có chắc muốn xóa "${book.title}"? Tất cả dữ liệu bao gồm file EPUB, ảnh bìa và audio sẽ bị xóa vĩnh viễn.`}
        confirmLabel={deleteMutation.isPending ? "Đang xóa..." : "Xóa truyện"}
        onConfirm={() => {
          deleteMutation.mutate();
          setShowDeleteConfirm(false);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
