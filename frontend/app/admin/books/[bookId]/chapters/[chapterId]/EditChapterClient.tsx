"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isAdmin, isAuthReady } from "@/lib/auth";
import { cacheChapterText } from "@/lib/chapterTextCache";
import { Spinner } from "@/components/ui/Spinner";

const SIDEBAR_PAGE_SIZE = 50;

// ─── Split-chapter helpers ───────────────────────────────────────────────────

interface SplitPart {
  title: string;
  text: string;
}

/** Auto-detect chapter split points by scanning for "Chương N / Chapter N" headers. */
function detectSplits(text: string, fallbackTitle: string): SplitPart[] {
  const HEADER_RE = /^(chương|chapter)\s+\d+/i;
  const lines = text.split("\n");
  const parts: SplitPart[] = [];
  let currentTitle = "";
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join("\n").trim();
    if (currentTitle || body) {
      const resolvedTitle = currentTitle || fallbackTitle;
      const textWithHeader = resolvedTitle
        ? `${resolvedTitle}\n${body}`
        : body;
      parts.push({ title: resolvedTitle, text: textWithHeader.trim() });
    }
  };

  for (const line of lines) {
    if (HEADER_RE.test(line.trim())) {
      flush();
      currentTitle = line.trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  return parts;
}

function SplitChapterModal({
  text,
  currentTitle,
  onConfirm,
  onClose,
}: {
  text: string;
  currentTitle: string;
  onConfirm: (parts: SplitPart[]) => Promise<void>;
  onClose: () => void;
}) {
  const [parts, setParts] = useState<SplitPart[]>(() =>
    detectSplits(text, currentTitle),
  );
  const [custom, setCustom] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateTitle(i: number, val: string) {
    setParts((ps) =>
      ps.map((p, j) => {
        if (j !== i) return p;
        // Keep the first line of text in sync with the title
        const lines = p.text.split("\n");
        const rest = lines.slice(1).join("\n");
        const newText = rest ? `${val}\n${rest}` : val;
        return { ...p, title: val, text: newText };
      }),
    );
  }

  function reSplit() {
    setError(null);
    const delim = custom.trim();
    if (!delim) {
      setParts(detectSplits(text, currentTitle));
      return;
    }
    const segments = text
      .split(delim)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (segments.length < 2) {
      setError(`Không tìm thấy "${delim}" trong văn bản.`);
      return;
    }
    setParts(
      segments.map((seg, i) => {
        const firstLine = seg.split("\n")[0].trim();
        const rest = seg.split("\n").slice(1).join("\n").trim();
        const title =
          firstLine.length > 0 && firstLine.length <= 200
            ? firstLine
            : `${currentTitle} (${i + 1})`;
        const textWithHeader = `${title}\n${rest || seg}`;
        return { title, text: textWithHeader.trim() };
      }),
    );
  }

  async function handleConfirm() {
    const bad = parts.findIndex((p) => !p.title.trim());
    if (bad >= 0) {
      setError(`Phần ${bad + 1} chưa có tiêu đề.`);
      return;
    }
    setError(null);
    setConfirming(true);
    try {
      await onConfirm(parts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi không xác định");
      setConfirming(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl bg-surface dark:bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-hairline-soft dark:border-hairline">
          <div>
            <h2 className="text-base font-semibold text-text dark:text-text">
              Tách chương
            </h2>
            {parts.length >= 2 ? (
              <p className="text-xs text-text-mute dark:text-text-mute mt-0.5">
                Phát hiện {parts.length} phần — chỉnh tiêu đề rồi xác nhận
              </p>
            ) : (
              <p className="text-xs text-orange-500 dark:text-orange-400 mt-0.5">
                Không phát hiện tiêu đề chương — nhập ký tự phân cách bên dưới
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-text-mute hover:text-text-dim dark:hover:text-text-dim rounded-lg transition-colors"
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

        {/* Custom delimiter row */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-hairline-soft dark:border-hairline-soft">
          <span className="text-xs text-text-mute dark:text-text-mute shrink-0">
            Tách theo:
          </span>
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && reSplit()}
            placeholder="Auto-detect (Chương N / Chapter N)"
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded border border-hairline dark:border-hairline bg-surface dark:bg-raised text-text dark:text-text placeholder-text-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={reSplit}
            className="px-3 py-1.5 text-xs font-medium text-accent dark:text-accent border border-accent/40 dark:border-accent/40 rounded-lg hover:bg-accent/15 dark:hover:bg-accent/30 transition-colors"
          >
            Phân tích lại
          </button>
        </div>

        {/* Parts list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
          {parts.length < 2 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-text-mute dark:text-text-dim">
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
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
              <span className="text-sm">
                Nhập ký tự phân cách rồi nhấn &quot;Phân tích lại&quot;
              </span>
            </div>
          ) : (
            parts.map((part, i) => (
              <div
                key={i}
                className="rounded-lg border border-hairline-soft dark:border-hairline p-3 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-accent dark:text-accent shrink-0">
                    #{i + 1}
                  </span>
                  <input
                    value={part.title}
                    onChange={(e) => updateTitle(i, e.target.value)}
                    placeholder="Tiêu đề chương..."
                    className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded border border-hairline dark:border-hairline bg-surface dark:bg-raised text-text dark:text-text placeholder-text-faint focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  <span className="text-xs text-text-mute dark:text-text-mute shrink-0">
                    {part.text
                      .split(/\s+/)
                      .filter(Boolean)
                      .length.toLocaleString()}{" "}
                    từ
                  </span>
                </div>
                <p className="text-xs text-text-mute dark:text-text-mute leading-relaxed line-clamp-2 font-mono">
                  {part.text.slice(0, 200)}
                  {part.text.length > 200 ? "…" : ""}
                </p>
              </div>
            ))
          )}
        </div>

        {error && (
          <div className="px-5 pb-2">
            <p className="text-xs text-vermillion dark:text-vermillion">{error}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-hairline-soft dark:border-hairline">
          <button
            type="button"
            onClick={onClose}
            disabled={confirming}
            className="px-4 py-2 text-sm font-medium text-text-dim dark:text-text-mute hover:text-text dark:hover:text-text transition-colors disabled:opacity-50"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={parts.length < 2 || confirming}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent-dim disabled:opacity-60 active:scale-[0.98] transition-all"
          >
            {confirming && <Spinner className="w-3.5 h-3.5" />}
            {confirming ? "Đang tách…" : `Tách thành ${parts.length} chương`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function EditChapterClient() {
  const params = useParams();
  const searchParams = useSearchParams();
  const bookId = (searchParams.get("bookId") || params?.bookId || "") as string;
  const chapterId = (searchParams.get("id") ||
    params?.chapterId ||
    "") as string;
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
  const [aiFixing, setAiFixing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  const [splitModalOpen, setSplitModalOpen] = useState(false);

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
    refetchOnWindowFocus: false,
  });

  // Current chapter metadata (not new)
  const { data: chapterMeta, isLoading: metaLoading } = useQuery({
    queryKey: ["chapter", chapterId],
    queryFn: () => api.getChapter(chapterId),
    enabled: !isNew && !!chapterId,
    refetchOnWindowFocus: false,
  });

  // Current chapter text (not new)
  const { data: chapterTextData, isLoading: textLoading } = useQuery({
    queryKey: ["chapterText", chapterId],
    queryFn: () => api.getChapterText(chapterId),
    enabled: !isNew && !!chapterId,
    refetchOnWindowFocus: false,
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

  // Jump sidebar to the page that contains the currently-edited chapter
  useEffect(() => {
    if (!chapterMeta || isNew || chapterMeta.id !== chapterId) return;
    const targetPage = Math.ceil(
      (chapterMeta.chapter_index + 1) / SIDEBAR_PAGE_SIZE,
    );
    setSidebarPage(targetPage);
  }, [chapterMeta, chapterId, isNew]);

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
        router.replace(`/admin/edit-chapter?bookId=${bookId}&id=${created.id}`);
      } else {
        const updated = await api.updateChapter(chapterId, {
          title: title.trim(),
          chapter_index: index - 1, // 0-based
          text_content: textContent.trim(),
        });
        // Write the edit through to this device's offline chapter-text cache
        // (listen/read pages serve from it) with the NEW version stamp —
        // otherwise the stale cached copy passes canUseCachedChapterText and
        // the edit appears to revert until the next version mismatch.
        await cacheChapterText(
          chapterId,
          textContent.trim(),
          updated.updated_at ?? undefined,
        );
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
    if (!confirm(`Xoá chương "${title}"? Thao tác này không thể hoàn tác.`))
      return;
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
        router.replace(`/admin/edit-chapter?bookId=${bookId}&id=${next.id}`);
      } else {
        router.replace(`/admin/edit-book?id=${bookId}`);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Xoá thất bại");
      setDeleting(false);
    }
  }

  async function handleAiFix() {
    if (!textContent.trim() || isNew) return;
    aiAbortRef.current?.abort();
    const ctrl = new AbortController();
    aiAbortRef.current = ctrl;
    setAiFixing(true);
    setAiError(null);
    const original = textContent;
    setTextContent("");
    try {
      await api.aiFixChapter(
        chapterId,
        original,
        (_delta, accumulated) => setTextContent(accumulated),
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setTextContent(original); // restore on cancel
      } else {
        setAiError(err instanceof Error ? err.message : "Lỗi AI");
        setTextContent(original);
      }
    } finally {
      setAiFixing(false);
    }
  }

  async function handleSplitConfirm(parts: SplitPart[]) {
    await api.splitChapter(
      chapterId,
      parts.map((p) => ({ title: p.title, text_content: p.text })),
    );
    queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
    queryClient.invalidateQueries({ queryKey: ["book", bookId] });
    queryClient.invalidateQueries({ queryKey: ["chapter", chapterId] });
    queryClient.invalidateQueries({ queryKey: ["chapterText", chapterId] });
    setSplitModalOpen(false);
    // Navigate away so the refreshed chapter list is visible
    router.replace(`/admin/edit-book?id=${bookId}`);
  }

  const sidebarChapters = sidebarData?.items ?? [];
  const sidebarTotalPages = sidebarData?.total_pages ?? 1;
  const editBasePath = `/admin/edit-chapter?bookId=${bookId}&id=`;

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
      <aside
        className={`
        fixed top-16 bottom-0 left-0 z-50 w-72 flex flex-col border-r border-hairline-soft dark:border-hairline bg-ink dark:bg-surface overflow-hidden
        transform transition-transform duration-200
        ${mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"}
        sm:sticky sm:top-16 sm:bottom-auto sm:left-auto sm:z-auto sm:translate-x-0
        sm:self-start sm:h-[calc(100vh-8rem)] sm:w-60 lg:w-64
      `}
      >
        {/* Header */}
        <div className="px-3 py-3 border-b border-hairline-soft dark:border-hairline space-y-2">
          <div className="flex items-center justify-between">
            <Link
              href={`/admin/edit-book?id=${bookId}`}
              className="flex items-center gap-1.5 text-xs text-text-mute dark:text-text-mute hover:text-accent dark:hover:text-accent transition-colors min-w-0"
            >
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
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              <span className="truncate">
                {book?.title ?? "Chỉnh sửa truyện"}
              </span>
            </Link>
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(false)}
              className="sm:hidden p-1.5 text-text-mute hover:text-text-dim dark:hover:text-text-dim rounded-lg active:bg-raised-hi dark:active:bg-raised-hi transition-colors shrink-0"
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
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <Link
            href={`/admin/edit-chapter?bookId=${bookId}&id=new`}
            className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 text-xs font-medium text-accent dark:text-accent border border-accent/40 dark:border-accent/40 rounded-lg hover:bg-accent/15 dark:hover:bg-accent/30 transition-colors"
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
                d="M12 4v16m8-8H4"
              />
            </svg>
            Thêm chương mới
          </Link>
        </div>

        {/* Chapter list */}
        <div className="flex-1 overflow-y-auto">
          {sidebarLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="w-5 h-5 text-accent" />
            </div>
          ) : (
            <ul>
              {isNew && (
                <li>
                  <span className="flex items-center gap-2 px-3 py-2.5 bg-accent text-white text-xs">
                    <svg
                      className="w-3 h-3 shrink-0"
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
                    <span className="truncate font-medium">Chương mới</span>
                  </span>
                </li>
              )}
              {sidebarChapters.map((ch) => {
                const isActive = ch.id === chapterId;
                return (
                  <li key={ch.id}>
                    <Link
                      href={`${editBasePath}${ch.id}`}
                      className={`flex items-center gap-2 px-3 py-2.5 text-xs transition-colors ${
                        isActive
                          ? "bg-accent text-white"
                          : "text-text-dim dark:text-text-faint hover:bg-raised dark:hover:bg-raised"
                      }`}
                    >
                      <span
                        className={`font-mono shrink-0 w-6 text-right ${isActive ? "text-accent" : "text-text-mute dark:text-text-mute"}`}
                      >
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
          <div className="flex items-center justify-between px-3 py-2 border-t border-hairline-soft dark:border-hairline">
            <button
              onClick={() => setSidebarPage((p) => Math.max(1, p - 1))}
              disabled={sidebarPage <= 1}
              className="p-1.5 rounded text-text-mute hover:text-accent hover:bg-raised dark:hover:bg-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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
            </button>
            <span className="text-xs text-text-mute dark:text-text-mute">
              {sidebarPage} / {sidebarTotalPages}
            </span>
            <button
              onClick={() =>
                setSidebarPage((p) => Math.min(sidebarTotalPages, p + 1))
              }
              disabled={sidebarPage >= sidebarTotalPages}
              className="p-1.5 rounded text-text-mute hover:text-accent hover:bg-raised dark:hover:bg-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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
                  d="M9 5l7 7-7 7"
                />
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
          className="sm:hidden flex items-center gap-2 mb-4 px-3 py-2 text-sm font-medium text-text-dim dark:text-text-mute border border-hairline-soft dark:border-hairline rounded-lg hover:bg-ink dark:hover:bg-raised active:bg-raised dark:active:bg-raised-hi transition-colors"
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
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
          Danh sách chương
        </button>

        {isLoading ? (
          <div className="flex justify-center py-24">
            <Spinner className="w-7 h-7 text-accent" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-5">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-bold text-text dark:text-text">
                {isNew ? "Thêm chương mới" : "Chỉnh sửa chương"}
              </h1>
              {!isNew && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSplitModalOpen(true)}
                    disabled={!textContent.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gold dark:text-gold border border-gold/40 dark:border-amber-700 rounded-lg hover:bg-gold/10 dark:hover:bg-gold/30 transition-colors disabled:opacity-40"
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
                        d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-11.516a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"
                      />
                    </svg>
                    Tách chương
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-vermillion dark:text-vermillion border border-vermillion/40 dark:border-vermillion/40 rounded-lg hover:bg-vermillion/10 dark:hover:bg-vermillion/30 transition-colors disabled:opacity-50"
                  >
                    {deleting ? (
                      <Spinner className="w-3 h-3" />
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
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    )}
                    Xoá chương
                  </button>
                </div>
              )}
            </div>

            {/* Title + Index row */}
            <div className="grid grid-cols-[1fr_140px] gap-4">
              <div>
                <label className="block text-xs font-medium text-text-dim dark:text-text-mute mb-1">
                  Tiêu đề chương *
                </label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  placeholder="Chương 1: Khởi đầu"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-hairline dark:border-hairline bg-surface dark:bg-surface text-text dark:text-text placeholder-text-faint focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-dim dark:text-text-mute mb-1">
                  Số chương *
                </label>
                <input
                  type="number"
                  min={1}
                  value={chapterIndex}
                  onChange={(e) => setChapterIndex(e.target.value)}
                  required
                  className="w-full px-3 py-2 text-sm rounded-lg border border-hairline dark:border-hairline bg-surface dark:bg-surface text-text dark:text-text focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            </div>

            {/* Text content */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-text-dim dark:text-text-mute">
                  Nội dung *
                </label>
                <div className="flex items-center gap-2">
                  {textContent && (
                    <span className="text-xs text-text-mute dark:text-text-mute">
                      {textContent
                        .split(/\s+/)
                        .filter(Boolean)
                        .length.toLocaleString()}{" "}
                      từ
                    </span>
                  )}
                  {!isNew && (
                    <button
                      type="button"
                      onClick={
                        aiFixing
                          ? () => aiAbortRef.current?.abort()
                          : handleAiFix
                      }
                      disabled={!textContent.trim()}
                      className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors disabled:opacity-40 ${
                        aiFixing
                          ? "bg-vermillion/15 dark:bg-vermillion/30 border-vermillion/40 dark:border-vermillion/40 text-vermillion dark:text-vermillion hover:bg-vermillion/20 dark:hover:bg-vermillion/50"
                          : "border-vermillion/30 dark:border-vermillion/40 text-vermillion dark:text-vermillion hover:bg-vermillion/15 dark:hover:bg-vermillion/30"
                      }`}
                    >
                      {aiFixing ? (
                        <>
                          <Spinner className="w-3 h-3" />
                          Huỷ
                        </>
                      ) : (
                        <>
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
                              d="M5 3l14 9-14 9V3z"
                            />
                          </svg>
                          Sửa AI
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
              {aiError && (
                <div className="mb-2 rounded-lg bg-vermillion/10 dark:bg-vermillion/50 border border-vermillion/30 dark:border-vermillion/40 px-3 py-2 text-xs text-vermillion dark:text-vermillion">
                  {aiError}
                </div>
              )}
              <textarea
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                required
                rows={16}
                placeholder="Nhập nội dung chương..."
                disabled={aiFixing}
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-hairline dark:border-hairline bg-surface dark:bg-surface text-text dark:text-text placeholder-text-faint focus:outline-none focus:ring-2 focus:ring-accent resize-y font-mono leading-relaxed disabled:opacity-60"
              />
              {aiFixing && (
                <p className="mt-1.5 text-xs text-vermillion dark:text-vermillion flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-vermillion animate-pulse" />
                  GPT đang xử lý...
                </p>
              )}
            </div>

            {saveError && (
              <div className="rounded-lg bg-vermillion/10 dark:bg-vermillion/50 border border-vermillion/30 dark:border-vermillion/40 px-4 py-3 text-sm text-vermillion dark:text-vermillion">
                {saveError}
              </div>
            )}
            {saveSuccess && (
              <div className="rounded-lg bg-accent/10 dark:bg-accent/50 border border-accent/30 dark:border-accent/40 px-4 py-3 text-sm text-accent-dim dark:text-accent">
                ✓ Đã lưu thành công
              </div>
            )}

            <div className="flex items-center gap-3 pb-6">
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 bg-accent text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-accent-dim disabled:opacity-60 active:scale-[0.98] transition-all"
              >
                {saving && <Spinner className="w-4 h-4" />}
                {saving ? "Đang lưu…" : isNew ? "Thêm chương" : "Lưu thay đổi"}
              </button>
              <Link
                href={`/admin/edit-book?id=${bookId}`}
                className="px-4 py-2.5 text-sm font-medium text-text-dim dark:text-text-mute hover:text-text dark:hover:text-text transition-colors"
              >
                Huỷ
              </Link>
            </div>
          </form>
        )}
      </main>

      {/* ─── Split Chapter Modal ─── */}
      {splitModalOpen && !isNew && (
        <SplitChapterModal
          text={textContent}
          currentTitle={title}
          onConfirm={handleSplitConfirm}
          onClose={() => setSplitModalOpen(false)}
        />
      )}
    </div>
  );
}
