"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isAdmin } from "@/lib/auth";
import { Spinner } from "@/components/ui/Spinner";

const SIDEBAR_PAGE_SIZE = 50;

export default function EditChapterClient() {
  const params = useParams();
  const bookId = params.bookId as string;
  const chapterId = params.chapterId as string;
  const isNew = chapterId === "new";
  const router = useRouter();
  const queryClient = useQueryClient();

  const [sidebarPage, setSidebarPage] = useState(1);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Form state
  const [title, setTitle] = useState("");
  const [chapterIndex, setChapterIndex] = useState("");
  const [textContent, setTextContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (!isAdmin()) router.replace("/");
  }, [router]);


  // Book info for sidebar header
  const { data: book } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
    enabled: !!bookId,
  });

  // Sidebar chapter list (paginated)
  const { data: sidebarData, isLoading: sidebarLoading } = useQuery({
    queryKey: ["chapters", bookId, sidebarPage, SIDEBAR_PAGE_SIZE],
    queryFn: () => api.getBookChapters(bookId, sidebarPage, SIDEBAR_PAGE_SIZE),
    enabled: !!bookId,
  });

  // Current chapter metadata (not new)
  const { data: chapterMeta, isLoading: metaLoading } = useQuery({
    queryKey: ["chapter", chapterId],
    queryFn: () => api.getChapter(chapterId),
    enabled: !isNew && !!chapterId,
  });

  // Current chapter text (not new)
  const { data: chapterTextData, isLoading: textLoading } = useQuery({
    queryKey: ["chapterText", chapterId],
    queryFn: () => api.getChapterText(chapterId),
    enabled: !isNew && !!chapterId,
  });

  // Populate form when data loads (or when chapterId changes)
  useEffect(() => {
    if (isNew) {
      setTitle("");
      setChapterIndex(String((book?.total_chapters ?? 0) + 1));
      setTextContent("");
      setSaveError(null);
      setSaveSuccess(false);
    }
  }, [isNew, chapterId, book?.total_chapters]);

  useEffect(() => {
    if (chapterMeta && !isNew) {
      setTitle(chapterMeta.title);
      setChapterIndex(String(chapterMeta.chapter_index + 1));
    }
  }, [chapterMeta, isNew, chapterId]);

  useEffect(() => {
    if (chapterTextData && !isNew) {
      setTextContent(chapterTextData.text_content);
    }
  }, [chapterTextData, isNew, chapterId]);

  // Reset success/error on chapter switch
  useEffect(() => {
    setSaveError(null);
    setSaveSuccess(false);
  }, [chapterId]);

  const isLoading = !isNew && (metaLoading || textLoading);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const index = parseInt(chapterIndex, 10);
    if (isNaN(index) || index < 1) {
      setSaveError("Số chương phải là số nguyên dương.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      if (isNew) {
        const created = await api.createChapter(bookId, {
          chapter_index: index - 1, // backend stores 0-based
          title: title.trim(),
          text_content: textContent.trim(),
        });
        queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
        queryClient.invalidateQueries({ queryKey: ["book", bookId] });
        router.replace(`/admin/books/${bookId}/chapters/${created.id}`);
      } else {
        await api.updateChapter(chapterId, {
          title: title.trim(),
          chapter_index: index - 1, // 0-based
          text_content: textContent.trim(),
        });
        queryClient.invalidateQueries({ queryKey: ["chapter", chapterId] });
        queryClient.invalidateQueries({ queryKey: ["chapterText", chapterId] });
        queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
        setSaveSuccess(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Lỗi không xác định";
      setSaveError(
        msg.includes("409") || msg.toLowerCase().includes("conflict")
          ? `Chương số ${chapterIndex} đã tồn tại.`
          : msg,
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Xoá chương "${title}"? Thao tác này không thể hoàn tác.`)) return;
    setDeleting(true);
    try {
      await api.deleteChapter(chapterId);
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
      queryClient.removeQueries({ queryKey: ["chapterText", chapterId] });
      // Navigate to adjacent chapter or back to edit page
      const chapters = sidebarData?.items ?? [];
      const idx = chapters.findIndex((c) => c.id === chapterId);
      const next = chapters[idx + 1] ?? chapters[idx - 1];
      if (next) {
        router.replace(`/admin/books/${bookId}/chapters/${next.id}`);
      } else {
        router.replace(`/admin/books/${bookId}/edit`);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Xoá thất bại");
      setDeleting(false);
    }
  }

  const sidebarChapters = sidebarData?.items ?? [];
  const sidebarTotalPages = sidebarData?.total_pages ?? 1;
  const editBasePath = `/admin/books/${bookId}/chapters`;

  return (
    <div className="flex -mt-6 -mx-4 sm:-mx-6">
      {/* Mobile backdrop */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 sm:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {/* ─── Sidebar ─── */}
      <aside className={`
        fixed top-16 bottom-0 left-0 z-50 w-72 flex flex-col border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-hidden
        transform transition-transform duration-200
        ${mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"}
        sm:relative sm:top-auto sm:bottom-auto sm:left-auto sm:z-auto sm:translate-x-0
        sm:sticky sm:top-16 sm:self-start sm:h-[calc(100vh-8rem)] sm:w-60 lg:w-64
      `}>
        {/* Header */}
        <div className="px-3 py-3 border-b border-gray-200 dark:border-gray-700 space-y-2">
          <div className="flex items-center justify-between">
            <Link
              href={`/admin/books/${bookId}/edit`}
              className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors min-w-0"
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              <span className="truncate">{book?.title ?? "Chỉnh sửa truyện"}</span>
            </Link>
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(false)}
              className="sm:hidden p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg active:bg-gray-200 dark:active:bg-gray-700 transition-colors shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <Link
            href={`/admin/books/${bookId}/chapters/new`}
            className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 border border-indigo-300 dark:border-indigo-700 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Thêm chương mới
          </Link>
        </div>

        {/* Chapter list */}
        <div className="flex-1 overflow-y-auto">
          {sidebarLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="w-5 h-5 text-indigo-600" />
            </div>
          ) : (
            <ul>
              {isNew && (
                <li>
                  <span className="flex items-center gap-2 px-3 py-2.5 bg-indigo-600 text-white text-xs">
                    <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    <span className="truncate font-medium">Chương mới</span>
                  </span>
                </li>
              )}
              {sidebarChapters.map((ch) => {
                const isActive = ch.id === chapterId;
                return (
                  <li key={ch.id}>
                    <Link
                      href={`${editBasePath}/${ch.id}`}
                      className={`flex items-center gap-2 px-3 py-2.5 text-xs transition-colors ${
                        isActive
                          ? "bg-indigo-600 text-white"
                          : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                      }`}
                    >
                      <span className={`font-mono shrink-0 w-6 text-right ${isActive ? "text-indigo-200" : "text-gray-400 dark:text-gray-500"}`}>
                        {ch.chapter_index + 1}
                      </span>
                      <span className="truncate">{ch.title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Sidebar pagination */}
        {sidebarTotalPages > 1 && (
          <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={() => setSidebarPage((p) => Math.max(1, p - 1))}
              disabled={sidebarPage <= 1}
              className="p-1.5 rounded text-gray-500 hover:text-indigo-600 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {sidebarPage} / {sidebarTotalPages}
            </span>
            <button
              onClick={() => setSidebarPage((p) => Math.min(sidebarTotalPages, p + 1))}
              disabled={sidebarPage >= sidebarTotalPages}
              className="p-1.5 rounded text-gray-500 hover:text-indigo-600 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}
      </aside>

      {/* ─── Main form ─── */}
      <main className="flex-1 min-w-0 px-4 sm:px-6 py-6">
        {/* Mobile: chapter list toggle */}
        <button
          type="button"
          onClick={() => setMobileSidebarOpen(true)}
          className="sm:hidden flex items-center gap-2 mb-4 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          Danh sách chương
        </button>

        {isLoading ? (
          <div className="flex justify-center py-24">
            <Spinner className="w-7 h-7 text-indigo-600" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-5">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {isNew ? "Thêm chương mới" : "Chỉnh sửa chương"}
              </h1>
              {!isNew && (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 border border-red-300 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-50"
                >
                  {deleting ? (
                    <Spinner className="w-3 h-3" />
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  )}
                  Xoá chương
                </button>
              )}
            </div>

            {/* Title + Index row */}
            <div className="grid grid-cols-[1fr_140px] gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Tiêu đề chương *
                </label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  placeholder="Chương 1: Khởi đầu"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Số chương *
                </label>
                <input
                  type="number"
                  min={1}
                  value={chapterIndex}
                  onChange={(e) => setChapterIndex(e.target.value)}
                  required
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>

            {/* Text content */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Nội dung *
                </label>
                {textContent && (
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {textContent.split(/\s+/).filter(Boolean).length.toLocaleString()} từ
                  </span>
                )}
              </div>
              <textarea
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                required
                rows={16}
                placeholder="Nhập nội dung chương..."
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y font-mono leading-relaxed"
              />
            </div>

            {saveError && (
              <div className="rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                {saveError}
              </div>
            )}
            {saveSuccess && (
              <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
                ✓ Đã lưu thành công
              </div>
            )}

            <div className="flex items-center gap-3 pb-6">
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 bg-indigo-600 text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-indigo-700 disabled:opacity-60 active:scale-[0.98] transition-all"
              >
                {saving && <Spinner className="w-4 h-4" />}
                {saving ? "Đang lưu…" : isNew ? "Thêm chương" : "Lưu thay đổi"}
              </button>
              <Link
                href={`/admin/books/${bookId}/edit`}
                className="px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
              >
                Huỷ
              </Link>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
