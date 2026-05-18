"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isAdmin, isAuthReady } from "@/lib/auth";
import { ChapterList } from "@/components/books/ChapterList";
import { GenreManager } from "@/components/books/GenreManager";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";

export default function EditBookClient() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const bookId = searchParams.get("id") || pathname.split("/")[3] || "";
  const router = useRouter();
  const queryClient = useQueryClient();

  const [chapterPage, setChapterPage] = useState(1);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [autoSplitRunning, setAutoSplitRunning] = useState(false);
  const [autoSplitResult, setAutoSplitResult] = useState<{
    old_count: number;
    new_count: number;
    missing_chapters: Array<{ title: string; chapter_index: number }>;
  } | null>(null);
  const [autoSplitError, setAutoSplitError] = useState<string | null>(null);

  const [reparseRunning, setReparseRunning] = useState(false);
  const [reparseSource, setReparseSource] = useState<string | null>(null);
  const [reparseError, setReparseError] = useState<string | null>(null);

  const [stripTarget, setStripTarget] = useState("");
  const [stripRunning, setStripRunning] = useState(false);
  const [stripResult, setStripResult] = useState<{ updated_chapters: number } | null>(null);
  const [stripError, setStripError] = useState<string | null>(null);

  useEffect(() => {
    const checkAdmin = () => {
      if (!isAdmin()) router.replace("/");
    };
    if (isAuthReady()) {
      checkAdmin();
    } else {
      // Native: localStorage is empty until hydrateAuthFromNative() finishes.
      // Wait for the auth-change event fired by providers.tsx after hydration.
      window.addEventListener("auth-change", checkAdmin, { once: true });
      return () => window.removeEventListener("auth-change", checkAdmin);
    }
  }, [router]);

  const { data: book, isLoading: bookLoading } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
    enabled: !!bookId,
  });

  const { data: chaptersData, isLoading: chaptersLoading } = useQuery({
    queryKey: ["chapters", bookId, chapterPage],
    queryFn: () => api.getBookChapters(bookId, chapterPage),
    enabled: !!book,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteBook(bookId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      router.push("/");
    },
  });

  if (bookLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="w-8 h-8 text-accent" />
      </div>
    );
  }

  if (!book) {
    return (
      <div className="text-center py-24">
        <p className="text-text-mute dark:text-text-mute font-medium">
          Không tìm thấy truyện
        </p>
        <Link
          href="/"
          className="text-sm text-accent hover:text-accent-dim mt-2 inline-block"
        >
          Quay lại thư viện
        </Link>
      </div>
    );
  }

  const chapters = chaptersData?.items ?? [];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-text-mute dark:text-text-mute min-w-0">
        <Link
          href="/"
          className="hover:text-accent dark:hover:text-accent transition-colors shrink-0"
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
        <Link
          href={`/book?id=${bookId}`}
          className="hover:text-accent dark:hover:text-accent transition-colors truncate max-w-xs"
        >
          {book.title}
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
        <span className="text-text dark:text-text font-medium shrink-0">
          Chỉnh sửa
        </span>
      </nav>

      <h1 className="text-2xl font-bold text-text dark:text-text">
        Chỉnh sửa truyện
      </h1>

      {/* Book Info */}
      <section className="bg-surface dark:bg-raised rounded-2xl border border-hairline-soft dark:border-hairline shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline-soft dark:border-hairline">
          <h2 className="text-sm font-semibold text-text dark:text-text">
            Thông tin cơ bản
          </h2>
        </div>
        <div className="p-5">
          <BookInfoEditor
            bookId={bookId}
            book={book}
            onSaved={() =>
              queryClient.invalidateQueries({ queryKey: ["book", bookId] })
            }
          />
        </div>
      </section>

      {/* Genres */}
      <section className="bg-surface dark:bg-raised rounded-2xl border border-hairline-soft dark:border-hairline shadow-sm">
        <div className="px-5 py-4 border-b border-hairline-soft dark:border-hairline">
          <h2 className="text-sm font-semibold text-text dark:text-text">
            Thể loại
          </h2>
        </div>
        <div className="p-5">
          <GenreManager bookId={bookId} />
        </div>
      </section>

      {/* Chapters */}
      <section className="bg-surface dark:bg-raised rounded-2xl border border-hairline-soft dark:border-hairline shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline-soft dark:border-hairline flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text dark:text-text">
            Danh sách chương
            {chaptersData && (
              <span className="ml-2 text-xs font-medium text-text-mute bg-raised dark:bg-raised-hi px-2 py-0.5 rounded-full">
                {chaptersData.total}
              </span>
            )}
          </h2>
        </div>
        <div className="p-5 space-y-5">
          <AddChapterForm
            bookId={bookId}
            currentTotal={book.total_chapters}
            onSaved={() => {
              queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
              queryClient.invalidateQueries({ queryKey: ["book", bookId] });
            }}
          />
          <div className="border-t border-hairline-soft dark:border-hairline pt-5">
            {chaptersLoading ? (
              <div className="flex justify-center py-10">
                <Spinner className="w-6 h-6 text-accent" />
              </div>
            ) : (
              <ChapterList
                chapters={chapters}
                bookId={bookId}
                page={chaptersData?.page ?? 1}
                totalPages={chaptersData?.total_pages ?? 1}
                total={chaptersData?.total ?? 0}
                onPageChange={setChapterPage}
                editBasePath={`/admin/edit-chapter?bookId=${bookId}&id=`}
              />
            )}
          </div>
        </div>
      </section>

      {/* Reparse */}
      <section className="bg-surface dark:bg-raised rounded-2xl border border-hairline-soft dark:border-hairline shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline-soft dark:border-hairline">
          <h2 className="text-sm font-semibold text-text dark:text-text">
            Phân tích lại từ file gốc
          </h2>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-text-mute dark:text-text-mute">
            Chạy lại trình phân tích EPUB trên file gốc đã lưu trong{" "}
            <span className="font-mono bg-raised dark:bg-raised-hi px-1 rounded">
              epub-uploads
            </span>
            . Toàn bộ chương cũ + audio sẽ bị xóa. Dùng khi parser được sửa lỗi
            mà không muốn upload lại file lớn.
          </p>
          <button
            type="button"
            disabled={reparseRunning}
            onClick={async () => {
              if (
                !window.confirm(
                  "Xóa toàn bộ chương + audio hiện tại và phân tích lại từ file gốc?",
                )
              )
                return;
              setReparseRunning(true);
              setReparseSource(null);
              setReparseError(null);
              try {
                const result = await api.reparseBook(bookId);
                setReparseSource(result.source);
                queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
                queryClient.invalidateQueries({ queryKey: ["book", bookId] });
              } catch (err) {
                setReparseError(
                  err instanceof Error ? err.message : "Lỗi không xác định",
                );
              } finally {
                setReparseRunning(false);
              }
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-accent dark:text-accent border border-accent/40 dark:border-accent/40 rounded-lg hover:bg-accent/15 dark:hover:bg-accent/30 disabled:opacity-60 transition-colors"
          >
            {reparseRunning && <Spinner className="w-4 h-4" />}
            {reparseRunning ? "Đang khởi chạy…" : "Phân tích lại"}
          </button>
          {reparseError && (
            <p className="text-xs text-vermillion dark:text-vermillion">
              {reparseError}
            </p>
          )}
          {reparseSource && (
            <p className="text-xs text-accent dark:text-accent">
              Đã khởi chạy phân tích lại từ{" "}
              <span className="font-mono">{reparseSource}</span>. Trạng thái
              sách sẽ chuyển sang <span className="font-medium">parsing</span>{" "}
              → <span className="font-medium">parsed</span> →{" "}
              <span className="font-medium">converting</span>.
            </p>
          )}
        </div>
      </section>

      {/* Auto-split */}
      <section className="bg-surface dark:bg-raised rounded-2xl border border-hairline-soft dark:border-hairline shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline-soft dark:border-hairline">
          <h2 className="text-sm font-semibold text-text dark:text-text">
            Tự động tách chương
          </h2>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-text-mute dark:text-text-mute">
            Gộp toàn bộ nội dung lại rồi tách theo tiêu đề{" "}
            <span className="font-mono bg-raised dark:bg-raised-hi px-1 rounded">
              Chương N
            </span>{" "}
            /{" "}
            <span className="font-mono bg-raised dark:bg-raised-hi px-1 rounded">
              Chapter N
            </span>
            . Audio cũ sẽ bị xóa, tất cả chương mới về trạng thái{" "}
            <span className="font-medium">pending</span>.
          </p>
          <button
            type="button"
            disabled={autoSplitRunning}
            onClick={async () => {
              setAutoSplitRunning(true);
              setAutoSplitResult(null);
              setAutoSplitError(null);
              try {
                const result = await api.autoSplitBook(bookId);
                setAutoSplitResult(result);
                queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
                queryClient.invalidateQueries({ queryKey: ["book", bookId] });
              } catch (err) {
                setAutoSplitError(
                  err instanceof Error ? err.message : "Lỗi không xác định",
                );
              } finally {
                setAutoSplitRunning(false);
              }
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-accent dark:text-accent border border-accent/40 dark:border-accent/40 rounded-lg hover:bg-accent/15 dark:hover:bg-accent/30 disabled:opacity-60 transition-colors"
          >
            {autoSplitRunning && <Spinner className="w-4 h-4" />}
            {autoSplitRunning ? "Đang tách…" : "Chạy tách tự động"}
          </button>
          {autoSplitError && (
            <p className="text-xs text-vermillion dark:text-vermillion">
              {autoSplitError}
            </p>
          )}
          {autoSplitResult && (
            <div className="space-y-2">
              <p className="text-xs text-accent dark:text-accent font-medium">
                Hoàn thành: {autoSplitResult.old_count} → {autoSplitResult.new_count} chương
              </p>
              {autoSplitResult.missing_chapters.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gold dark:text-gold mb-1">
                    {autoSplitResult.missing_chapters.length} chương thiếu nội dung:
                  </p>
                  <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                    {autoSplitResult.missing_chapters.map((ch) => (
                      <li
                        key={ch.chapter_index}
                        className="text-xs text-text-dim dark:text-text-mute font-mono bg-gold/10 dark:bg-gold/20 px-2 py-0.5 rounded"
                      >
                        [{ch.chapter_index + 1}] {ch.title}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Strip string */}
      <section className="bg-surface dark:bg-raised rounded-2xl border border-hairline-soft dark:border-hairline shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline-soft dark:border-hairline">
          <h2 className="text-sm font-semibold text-text dark:text-text">
            Xóa chuỗi khỏi tất cả chương
          </h2>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-text-mute dark:text-text-mute">
            Nhập chuỗi cần xóa (khớp chính xác) khỏi nội dung văn bản của mọi chương trong truyện.
          </p>
          <textarea
            rows={3}
            value={stripTarget}
            onChange={(e) => { setStripTarget(e.target.value); setStripResult(null); setStripError(null); }}
            placeholder="Nhập chuỗi cần xóa…"
            className="w-full rounded-lg border border-hairline-soft dark:border-hairline bg-ink dark:bg-surface text-sm text-text dark:text-text px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent font-mono"
          />
          <button
            type="button"
            disabled={stripRunning || !stripTarget}
            onClick={async () => {
              setStripRunning(true);
              setStripResult(null);
              setStripError(null);
              try {
                const result = await api.stripStringFromChapters(bookId, stripTarget);
                setStripResult(result);
                queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
              } catch (err) {
                setStripError(err instanceof Error ? err.message : "Lỗi không xác định");
              } finally {
                setStripRunning(false);
              }
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-accent dark:text-accent border border-accent/40 dark:border-accent/40 rounded-lg hover:bg-accent/15 dark:hover:bg-accent/30 disabled:opacity-60 transition-colors"
          >
            {stripRunning && <Spinner className="w-4 h-4" />}
            {stripRunning ? "Đang xóa…" : "Xóa chuỗi"}
          </button>
          {stripError && (
            <p className="text-xs text-vermillion dark:text-vermillion">{stripError}</p>
          )}
          {stripResult && (
            <p className="text-xs text-accent dark:text-accent font-medium">
              Hoàn thành: đã cập nhật {stripResult.updated_chapters} chương.
            </p>
          )}
        </div>
      </section>

      {/* Danger Zone */}
      <section className="bg-surface dark:bg-raised rounded-2xl border border-vermillion/30 dark:border-vermillion/40/50 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-vermillion/30 dark:border-vermillion/40/30">
          <h2 className="text-sm font-semibold text-vermillion dark:text-vermillion">
            Vùng nguy hiểm
          </h2>
        </div>
        <div className="p-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-text dark:text-text">
              Xóa truyện
            </p>
            <p className="text-xs text-text-mute dark:text-text-mute mt-0.5">
              Xóa vĩnh viễn toàn bộ truyện, chương, file audio và ảnh bìa. Không
              thể hoàn tác.
            </p>
          </div>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="shrink-0 flex items-center gap-2 px-4 py-2 text-sm font-medium text-vermillion dark:text-vermillion border border-vermillion/40 dark:border-vermillion/40 rounded-lg hover:bg-vermillion/10 dark:hover:bg-vermillion/30 transition-colors"
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
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
            Xóa truyện
          </button>
        </div>
      </section>

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

// ─── BookInfoEditor ───────────────────────────────────────────────────────────

function BookInfoEditor({
  bookId,
  book,
  onSaved,
}: {
  bookId: string;
  book: {
    title: string;
    author?: string | null;
    description?: string | null;
    cover_url?: string | null;
    story_status?: string | null;
  };
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [description, setDescription] = useState(book.description ?? "");
  const [storyStatus, setStoryStatus] = useState(
    book.story_status ?? "unknown",
  );
  const [cover, setCover] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Keep in sync if parent refetches
  useEffect(() => {
    setTitle(book.title);
  }, [book.title]);
  useEffect(() => {
    setAuthor(book.author ?? "");
  }, [book.author]);
  useEffect(() => {
    setDescription(book.description ?? "");
  }, [book.description]);
  useEffect(() => {
    setStoryStatus(book.story_status ?? "unknown");
  }, [book.story_status]);

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
      await api.updateBook(bookId, {
        title,
        author: author || undefined,
        description: description || undefined,
        story_status: storyStatus,
        cover,
      });
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

  const currentCover = coverPreview ?? book.cover_url ?? null;

  return (
    <form onSubmit={handleSave} className="space-y-5">
      {/* Cover + fields side by side on wider screens */}
      <div className="flex flex-col sm:flex-row gap-5">
        {/* Cover image */}
        <div className="shrink-0 flex flex-col items-center gap-2">
          <div className="w-28 h-40 rounded-xl overflow-hidden bg-linear-to-br from-raised to-raised-hi dark:from-raised dark:to-raised-hi border border-hairline-soft dark:border-hairline shadow-sm">
            {currentCover ? (
              <Image
                src={currentCover}
                alt="cover"
                width={112}
                height={160}
                className="object-cover w-full h-full"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-accent dark:text-accent-dim">
                <svg
                  className="w-10 h-10"
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
          <label className="cursor-pointer">
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-dim dark:text-text-mute border border-hairline dark:border-hairline rounded-lg hover:border-accent/40 hover:text-accent hover:bg-accent/15 dark:hover:bg-accent/30 transition-colors">
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
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
              {cover ? "Đã chọn" : "Đổi ảnh bìa"}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleCover}
              className="sr-only"
            />
          </label>
          {cover && (
            <button
              type="button"
              onClick={() => {
                setCover(null);
                setCoverPreview(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
              className="text-xs text-vermillion hover:text-vermillion transition-colors"
            >
              Bỏ chọn
            </button>
          )}
        </div>

        {/* Text fields */}
        <div className="flex-1 space-y-3 min-w-0">
          <div>
            <label className="block text-xs font-medium text-text-dim dark:text-text-mute mb-1">
              Tên truyện *
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm rounded-lg border border-hairline dark:border-hairline bg-surface dark:bg-surface text-text dark:text-text focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-dim dark:text-text-mute mb-1">
              Tác giả
            </label>
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Không rõ"
              className="w-full px-3 py-2 text-sm rounded-lg border border-hairline dark:border-hairline bg-surface dark:bg-surface text-text dark:text-text placeholder-text-faint focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>
      </div>

      {/* Story status */}
      <div>
        <label className="block text-xs font-medium text-text-dim dark:text-text-mute mb-1">
          Tình trạng
        </label>
        <select
          value={storyStatus}
          onChange={(e) => setStoryStatus(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded-lg border border-hairline dark:border-hairline bg-surface dark:bg-surface text-text dark:text-text focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="unknown">Chưa rõ</option>
          <option value="ongoing">Đang ra</option>
          <option value="completed">Hoàn thành</option>
        </select>
      </div>

      {/* Description */}
      <div>
        <label className="block text-xs font-medium text-text-dim dark:text-text-mute mb-1">
          Mô tả / Giới thiệu
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="Nhập mô tả về nội dung truyện..."
          className="w-full px-3 py-2 text-sm rounded-lg border border-hairline dark:border-hairline bg-surface dark:bg-surface text-text dark:text-text placeholder-text-faint focus:outline-none focus:ring-2 focus:ring-accent resize-y"
        />
      </div>

      {error && (
        <p className="text-sm text-vermillion dark:text-vermillion">{error}</p>
      )}
      {success && (
        <p className="text-sm text-accent dark:text-accent">
          ✓ Đã lưu thành công
        </p>
      )}

      <button
        type="submit"
        disabled={saving}
        className="flex items-center gap-2 bg-accent text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-accent-dim disabled:opacity-60 transition-colors"
      >
        {saving && <Spinner className="w-4 h-4" />}
        {saving ? "Đang lưu…" : "Lưu thay đổi"}
      </button>
    </form>
  );
}

// ─── AddChapterForm ───────────────────────────────────────────────────────────

function AddChapterForm({
  bookId,
  currentTotal,
  onSaved,
}: {
  bookId: string;
  currentTotal: number;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [chapterIndex, setChapterIndex] = useState(String(currentTotal + 1));
  const [title, setTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (open) setChapterIndex(String(currentTotal + 1));
  }, [open, currentTotal]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const index = parseInt(chapterIndex, 10);
    if (isNaN(index) || index < 1) {
      setError("Số chương phải là số nguyên dương.");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await api.createChapter(bookId, {
        chapter_index: index - 1,
        title: title.trim(),
        text_content: textContent.trim(),
      });
      onSaved();
      setSuccess(true);
      setTitle("");
      setTextContent("");
      setTimeout(() => {
        setOpen(false);
        setSuccess(false);
      }, 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Lỗi không xác định";
      setError(
        msg.includes("409") || msg.toLowerCase().includes("conflict")
          ? `Chương số ${chapterIndex} đã tồn tại.`
          : msg,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-accent dark:text-accent border border-accent/40 dark:border-accent/40 rounded-lg hover:bg-accent/15 dark:hover:bg-accent/30 transition-colors"
      >
        <svg
          className={`w-4 h-4 transition-transform ${open ? "rotate-45" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 4v16m8-8H4"
          />
        </svg>
        Thêm chương mới
      </button>

      {open && (
        <form
          onSubmit={handleSubmit}
          className="mt-4 space-y-3 p-4 bg-ink dark:bg-surface/50 rounded-xl border border-hairline-soft dark:border-hairline"
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-dim dark:text-text-mute mb-1">
                Số chương
              </label>
              <input
                type="number"
                min={1}
                value={chapterIndex}
                onChange={(e) => setChapterIndex(e.target.value)}
                required
                placeholder="1"
                className="w-full px-3 py-2 text-sm rounded-lg border border-hairline dark:border-hairline bg-surface dark:bg-raised text-text dark:text-text focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-dim dark:text-text-mute mb-1">
                Tiêu đề
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                placeholder="Chương 1: …"
                className="w-full px-3 py-2 text-sm rounded-lg border border-hairline dark:border-hairline bg-surface dark:bg-raised text-text dark:text-text focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-dim dark:text-text-mute mb-1">
              Nội dung
            </label>
            <textarea
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              required
              rows={8}
              placeholder="Nhập nội dung chương…"
              className="w-full px-3 py-2 text-sm rounded-lg border border-hairline dark:border-hairline bg-surface dark:bg-raised text-text dark:text-text focus:outline-none focus:ring-2 focus:ring-accent resize-y font-mono leading-relaxed"
            />
          </div>
          {error && (
            <p className="text-xs text-vermillion dark:text-vermillion">{error}</p>
          )}
          {success && (
            <p className="text-xs text-accent dark:text-accent">
              ✓ Đã thêm chương thành công!
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 bg-accent text-white text-xs font-medium px-4 py-2 rounded-lg hover:bg-accent-dim disabled:opacity-60 transition-colors"
            >
              {saving && <Spinner className="w-3 h-3" />}
              {saving ? "Đang lưu…" : "Thêm chương"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-text-mute dark:text-text-mute hover:text-text-dim dark:hover:text-text-dim px-3 py-2 transition-colors"
            >
              Hủy
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
