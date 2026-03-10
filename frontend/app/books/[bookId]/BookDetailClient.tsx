"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, usePathname } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isLoggedIn, isAdmin } from "@/lib/auth";
import { ChapterList } from "@/components/books/ChapterList";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import { GenreTag, GenreManager } from "@/components/books/GenreManager";
import {
  cacheChapterText,
  isChapterTextCached,
} from "@/lib/chapterTextCache";

export default function BookDetailPage() {
  const bookId = usePathname().split("/")[2];
  const [page, setPage] = useState(1);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [adminTab, setAdminTab] = useState<"info" | "genres" | "chapter">("info");
  const [dlProgress, setDlProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [dlDone, setDlDone] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => {
    const sync = () => setAdmin(isAdmin());
    sync();
    window.addEventListener("auth-change", sync);
    return () => window.removeEventListener("auth-change", sync);
  }, []);

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteBook(bookId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      router.push("/");
    },
  });

  const {
    data: book,
    isLoading: bookLoading,
  } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "parsing" ? 2000 : false;
    },
  });

  const isParsing =
    book?.status === "pending" || book?.status === "parsing";

  const { data: chaptersData, isLoading: chaptersLoading } = useQuery({
    queryKey: ["chapters", bookId, page],
    queryFn: () => api.getBookChapters(bookId, page),
    enabled: !!book && !isParsing,
  });

  // Fetch last-accessed chapter so buttons resume where user left off
  const { data: bookProgress } = useQuery({
    queryKey: ["bookProgress", bookId],
    queryFn: () => api.getBookProgress(bookId),
    enabled: !!book && isLoggedIn(),
  });

  // Read + listen share one DB progress row (progress_type was removed).
  // The listen page saves its own last-chapter to localStorage so "Continue
  // Listening" resumes at the correct audio chapter even when reading got ahead.
  const [lastListenChapterId, setLastListenChapterId] = useState<string | null>(null);
  useEffect(() => {
    const stored = localStorage.getItem(`listen-chapter:${bookId}`);
    setLastListenChapterId(stored);
  }, [bookId]);

  async function handleDownloadBook() {
    if (dlProgress) return;
    setDlDone(false);

    // Paginate through all chapters (Supabase caps at 1000 per query)
    const PAGE_SIZE = 1000;
    const allChapters: { id: string }[] = [];
    let pg = 1;
    while (true) {
      const res = await api.getBookChapters(bookId, pg, PAGE_SIZE);
      allChapters.push(...res.items);
      if (pg >= res.total_pages) break;
      pg++;
    }

    if (allChapters.length === 0) return;
    const total = allChapters.length;
    setDlProgress({ done: 0, total });
    let done = 0;
    for (const ch of allChapters) {
      try {
        const cached = await isChapterTextCached(ch.id);
        if (!cached) {
          const result = await api.getChapterText(ch.id);
          await cacheChapterText(ch.id, result.text_content);
        }
      } catch {
        // skip failed chapters
      }
      done++;
      setDlProgress({ done, total });
    }
    setDlDone(true);
    setDlProgress(null);
  }

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

  const chapters = chaptersData?.items ?? [];
  const firstChapter = chapters[0] ?? null;

  // Use localStorage-tracked listen chapter for audio resumption;
  // fall back to DB progress (which may be a read position), then first chapter.
  const listenResumeId = lastListenChapterId ?? bookProgress?.chapter_id ?? firstChapter?.id;
  const readResumeId = bookProgress?.chapter_id ?? firstChapter?.id;
  const hasProgress = !!bookProgress || !!lastListenChapterId;

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
        {admin && (
        <div className="flex items-center gap-1.5 shrink-0 ml-3">
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="p-2 rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
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
        </div>
        )}
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
              {/* Genre tags */}
              {book.genres && book.genres.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {book.genres.map((g) => <GenreTag key={g.id} genre={g} />)}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Admin panel */}
        {admin && (
          <div className="border-t border-gray-100 dark:border-gray-700">
            <button
              onClick={() => setShowAdminPanel((v) => !v)}
              className="w-full flex items-center justify-between px-5 sm:px-6 py-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Quản trị
              </span>
              <svg className={`w-4 h-4 transition-transform ${showAdminPanel ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showAdminPanel && (
              <div className="px-5 sm:px-6 pb-5">
                {/* Tabs */}
                <div className="flex gap-1 mb-4 bg-gray-100 dark:bg-gray-700/50 p-1 rounded-lg">
                  {(["info", "genres", "chapter"] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setAdminTab(tab)}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                        adminTab === tab
                          ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                          : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                      }`}
                    >
                      {tab === "info" ? "Thông tin" : tab === "genres" ? "Thể loại" : "Thêm chương"}
                    </button>
                  ))}
                </div>

                {adminTab === "info" && (
                  <BookInfoEditor bookId={bookId} book={book} onSaved={() => queryClient.invalidateQueries({ queryKey: ["book", bookId] })} />
                )}
                {adminTab === "genres" && (
                  <GenreManager bookId={bookId} assignedGenres={book.genres ?? []} />
                )}
                {adminTab === "chapter" && (
                  <AddChapterForm bookId={bookId} onSaved={() => {
                    queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
                    queryClient.invalidateQueries({ queryKey: ["book", bookId] });
                  }} />
                )}
              </div>
            )}
          </div>
        )}

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
          <div className="flex flex-col gap-3 mx-5 sm:mx-6 mb-5 sm:mb-6">
            <div className="grid grid-cols-2 gap-3">
              <Link
                href={
                  listenResumeId
                    ? `/books/${bookId}/listen?chapter=${listenResumeId}`
                    : "#"
                }
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
                    {hasProgress ? "Nghe tiếp" : "Nghe ngay"}
                  </p>
                  <p className="text-[11px] text-indigo-200 mt-0.5">
                    {hasProgress
                      ? "Tiếp tục từ chỗ dừng"
                      : "TTS trực tiếp"}
                  </p>
                </div>
              </Link>
              <Link
                href={
                  readResumeId
                    ? `/books/${bookId}/read?chapter=${readResumeId}`
                    : "#"
                }
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
                    {hasProgress ? "Đọc tiếp" : "Đọc truyện"}
                  </p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                    {hasProgress
                      ? "Tiếp tục từ chỗ dừng"
                      : "Đọc văn bản"}
                  </p>
                </div>
              </Link>
            </div>

            {/* Download book offline */}
            <button
              onClick={handleDownloadBook}
              disabled={!!dlProgress || dlDone}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                dlDone
                  ? "border-emerald-300 dark:border-emerald-700 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30"
                  : dlProgress
                    ? "border-indigo-300 dark:border-indigo-700 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30"
                    : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
              }`}
            >
              {dlProgress ? (
                <>
                  <Spinner className="w-4 h-4" />
                  <span>
                    Đang tải... {dlProgress.done}/{dlProgress.total}
                  </span>
                </>
              ) : dlDone ? (
                <>
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
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  <span>Đã lưu offline</span>
                </>
              ) : (
                <>
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
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </svg>
                  <span>Tải truyện offline</span>
                </>
              )}
            </button>
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
        confirmLabel={
          deleteMutation.isPending ? "Đang xóa..." : "Xóa truyện"
        }
        onConfirm={() => {
          deleteMutation.mutate();
          setShowDeleteConfirm(false);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}

// ---------- BookInfoEditor ----------
function BookInfoEditor({
  bookId,
  book,
  onSaved,
}: {
  bookId: string;
  book: { title: string; author?: string | null; cover_url?: string | null };
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [cover, setCover] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleCover = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setCover(f);
    setCoverPreview(f ? URL.createObjectURL(f) : null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await api.updateBook(bookId, { title, author: author || undefined, cover });
      onSaved();
      setSuccess(true);
      setCover(null);
      setCoverPreview(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lưu thất bại");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tên truyện</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tác giả</label>
        <input
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="Không rõ"
          className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Ảnh bìa</label>
        <div className="flex items-center gap-3">
          {(coverPreview ?? book.cover_url) && (
            <img
              src={coverPreview ?? book.cover_url!}
              alt="cover"
              className="w-12 h-16 object-cover rounded-lg border border-gray-200 dark:border-gray-700 shrink-0"
            />
          )}
          <label className="flex-1 cursor-pointer">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors text-xs text-gray-500 dark:text-gray-400">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              {cover ? cover.name : "Thay ảnh bìa…"}
            </div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleCover} className="sr-only" />
          </label>
        </div>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {success && <p className="text-xs text-emerald-600 dark:text-emerald-400">Đã lưu thành công!</p>}
      <button
        type="submit"
        disabled={saving}
        className="flex items-center gap-1.5 bg-indigo-600 text-white text-xs font-medium px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-60 transition-colors"
      >
        {saving && <Spinner className="w-3 h-3" />}
        {saving ? "Đang lưu…" : "Lưu thay đổi"}
      </button>
    </form>
  );
}

// ---------- AddChapterForm ----------
function AddChapterForm({ bookId, onSaved }: { bookId: string; onSaved: () => void }) {
  const [chapterIndex, setChapterIndex] = useState("");
  const [title, setTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const index = parseInt(chapterIndex, 10);
    if (isNaN(index) || index < 1) { setError("Số chương phải là số nguyên dương."); return; }
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await api.createChapter(bookId, { chapter_index: index, title: title.trim(), text_content: textContent.trim() });
      onSaved();
      setSuccess(true);
      setChapterIndex("");
      setTitle("");
      setTextContent("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Lỗi không xác định";
      setError(msg.includes("409") || msg.toLowerCase().includes("conflict") ? `Chương số ${chapterIndex} đã tồn tại.` : msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Số chương</label>
          <input type="number" min={1} value={chapterIndex} onChange={(e) => setChapterIndex(e.target.value)} required placeholder="1"
            className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tiêu đề</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="Chương 1: …"
            className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nội dung</label>
        <textarea value={textContent} onChange={(e) => setTextContent(e.target.value)} required rows={8} placeholder="Nhập nội dung chương…"
          className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y font-mono leading-relaxed" />
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {success && <p className="text-xs text-emerald-600 dark:text-emerald-400">Đã thêm chương thành công!</p>}
      <button type="submit" disabled={saving}
        className="flex items-center gap-1.5 bg-indigo-600 text-white text-xs font-medium px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-60 transition-colors">
        {saving && <Spinner className="w-3 h-3" />}
        {saving ? "Đang lưu…" : "Thêm chương"}
      </button>
    </form>
  );
}
