"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isLoggedIn } from "@/lib/auth";
import { useProgressSync } from "@/hooks/useProgressSync";
import { Spinner } from "@/components/ui/Spinner";
import { getLocalProgress, saveLocalBookProgress } from "@/lib/progressQueue";
import type { Chapter } from "@/types";

/**
 * Track actual reading engagement and award XP when the user has spent
 * enough time actively reading the chapter (visible page, not just loaded).
 * Threshold: max(15s, wordCount / 300 * 60 * 0.35) seconds, capped at 90s.
 */
function useReadingXp(
  chapterId: string | null,
  bookId: string,
  wordCount: number,
  hasText: boolean,
) {
  const completedRef = useRef<Set<string>>(new Set());
  const timeRef = useRef(0);
  const lastVisibleRef = useRef<number | null>(null);
  const scrolledPastRef = useRef(false);

  // Reset on chapter change
  useEffect(() => {
    timeRef.current = 0;
    lastVisibleRef.current = null;
    scrolledPastRef.current = false;
  }, [chapterId]);

  // Track scroll depth (need >25% scrolled)
  useEffect(() => {
    if (!hasText) return;
    const onScroll = () => {
      const scrollMax = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollMax <= 0) return;
      if (window.scrollY / scrollMax > 0.25) scrolledPastRef.current = true;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [hasText, chapterId]);

  // Accumulate visible time and fire XP when threshold met
  useEffect(() => {
    if (!chapterId || !hasText || !isLoggedIn()) return;

    const threshold = Math.min(
      90,
      Math.max(15, Math.round((wordCount / 300) * 60 * 0.35)),
    );

    const tick = () => {
      if (document.hidden) {
        lastVisibleRef.current = null;
        return;
      }
      const now = Date.now();
      if (lastVisibleRef.current !== null) {
        timeRef.current += (now - lastVisibleRef.current) / 1000;
      }
      lastVisibleRef.current = now;

      if (
        timeRef.current >= threshold &&
        scrolledPastRef.current &&
        !completedRef.current.has(chapterId)
      ) {
        completedRef.current.add(chapterId);
        api
          .completeChapter({ chapter_id: chapterId, book_id: bookId, mode: "read", word_count: wordCount })
          .catch(() => {});
      }
    };

    const onVisibility = () => {
      if (document.hidden) lastVisibleRef.current = null;
      else lastVisibleRef.current = Date.now();
    };

    lastVisibleRef.current = document.hidden ? null : Date.now();
    const interval = setInterval(tick, 2000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [chapterId, bookId, wordCount, hasText]);
}

const FONT_SIZES = [14, 16, 18, 20, 22, 24] as const;
const FONT_KEY = "reader-font-size";
const FONT_FAMILY_KEY = "reader-font-family";
const THEME_KEY = "reader-theme";

interface ReaderTheme {
  name: string;
  bg: string;
  text: string;
  label: string;
}

const READER_THEMES: ReaderTheme[] = [
  { name: "light", bg: "#ffffff", text: "#1f2937", label: "Sáng" },
  { name: "sepia", bg: "#f5f0e8", text: "#5c4b37", label: "Sepia" },
  { name: "dark", bg: "#1a1a2e", text: "#e0e0e0", label: "Tối" },
  { name: "neon", bg: "#040714", text: "#22b80a", label: "Neon" },
  { name: "warm", bg: "#2d1b00", text: "#f5c882", label: "Ấm" },
  { name: "gray", bg: "#2a2a2a", text: "#cccccc", label: "Xám" },
];

const FONT_FAMILIES = [
  { value: "serif", label: "Serif" },
  { value: "sans-serif", label: "Sans" },
  { value: "'Georgia', serif", label: "Georgia" },
  { value: "'Times New Roman', serif", label: "Times" },
  { value: "system-ui, sans-serif", label: "System" },
  { value: "'Courier New', monospace", label: "Mono" },
];

export default function ReadPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const bookId = (searchParams.get("id") ||
    (params?.bookId as string) ||
    "") as string;
  const chapterId = searchParams.get("chapter");
  const router = useRouter();
  const contentRef = useRef<HTMLDivElement>(null);

  const [fontSize, setFontSize] = useState<number>(() => {
    if (typeof window === "undefined") return 18;
    const saved = localStorage.getItem(FONT_KEY);
    return saved ? parseInt(saved, 10) : 18;
  });
  const [fontFamily, setFontFamily] = useState<string>(() => {
    if (typeof window === "undefined") return "serif";
    return localStorage.getItem(FONT_FAMILY_KEY) || "serif";
  });
  const [theme, setTheme] = useState<ReaderTheme>(() => {
    if (typeof window === "undefined") return READER_THEMES[0];
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        /* ignore */
      }
    }
    return READER_THEMES[0];
  });
  const [customText, setCustomText] = useState(theme.text);
  const [customBg, setCustomBg] = useState(theme.bg);
  const [showSettings, setShowSettings] = useState(false);

  const { data: book } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
  });

  const { data: chaptersData } = useQuery({
    queryKey: ["chapters", bookId, "all"],
    queryFn: () => api.getAllBookChapters(bookId),
  });

  const { data: chapterText, isLoading: isLoadingText } = useQuery({
    queryKey: ["chapterText", chapterId],
    queryFn: () => api.getChapterText(chapterId!),
    enabled: !!chapterId,
  });

  // Fetch saved reading progress — falls back to offline queue.
  // Use getBookProgress (one row per book) and only restore if it's for THIS chapter.
  // getChapterProgress queries by chapter_id but the DB stores only the latest chapter
  // per book, so it returns null for any chapter that isn't the most recently visited.
  const { data: savedProgress } = useQuery({
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

  const allChapters = chaptersData?.items ?? [];
  const currentChapter = allChapters.find((c) => c.id === chapterId) ?? null;
  const currentIndex = currentChapter?.chapter_index ?? -1;
  const prevChapter =
    allChapters.find((c) => c.chapter_index === currentIndex - 1) ?? null;
  const nextChapter =
    allChapters.find((c) => c.chapter_index === currentIndex + 1) ?? null;

  const { reportProgress } = useProgressSync({
    bookId,
    chapterId: chapterId ?? "",
    chapterIndex: currentIndex >= 0 ? currentIndex : undefined,
  });

  // Award reading XP based on actual time spent on page
  useReadingXp(
    chapterId,
    bookId,
    currentChapter?.word_count ?? 0,
    !!chapterText?.text_content,
  );

  // Save book-level progress when the reading chapter changes
  useEffect(() => {
    if (!chapterId || !bookId || currentIndex < 0) return;
    saveLocalBookProgress({
      book_id: bookId,
      chapter_id: chapterId,
      chapter_index: currentIndex,
      progress_value: 0,
    });
  }, [bookId, chapterId, currentIndex]);

  const navigateTo = useCallback(
    (chapter: Chapter | null) => {
      if (chapter) {
        router.push(`/read?id=${bookId}&chapter=${chapter.id}`);
      }
    },
    [bookId, router],
  );

  // Scroll to top on chapter change (or restore saved position)
  const restoredRef = useRef(false);
  useEffect(() => {
    restoredRef.current = false;
    window.scrollTo({ top: 0 });
  }, [chapterId]);

  // Restore saved scroll position after text loads
  useEffect(() => {
    if (restoredRef.current || !savedProgress?.progress_value || !chapterText)
      return;
    restoredRef.current = true;
    // Wait for content to render
    requestAnimationFrame(() => {
      const scrollMax =
        document.documentElement.scrollHeight - window.innerHeight;
      const target = (savedProgress.progress_value / 100) * scrollMax;
      window.scrollTo({ top: target, behavior: "smooth" });
    });
  }, [savedProgress, chapterText]);

  // Track scroll progress
  useEffect(() => {
    if (!chapterId || !chapterText) return;
    const handleScroll = () => {
      const scrollMax =
        document.documentElement.scrollHeight - window.innerHeight;
      if (scrollMax <= 0) return;
      const pct = Math.round((window.scrollY / scrollMax) * 100);
      reportProgress(Math.min(pct, 100), 100);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [chapterId, chapterText, reportProgress]);

  function handleFontSize(size: number) {
    setFontSize(size);
    localStorage.setItem(FONT_KEY, String(size));
  }

  function handleFontFamily(ff: string) {
    setFontFamily(ff);
    localStorage.setItem(FONT_FAMILY_KEY, ff);
  }

  function handleTheme(t: ReaderTheme) {
    setTheme(t);
    setCustomText(t.text);
    setCustomBg(t.bg);
    localStorage.setItem(THEME_KEY, JSON.stringify(t));
  }

  function handleCustomColor(type: "text" | "bg", color: string) {
    const updated = {
      ...theme,
      name: "custom",
      label: "Tùy chọn",
      ...(type === "text" ? { text: color } : { bg: color }),
    };
    if (type === "text") setCustomText(color);
    else setCustomBg(color);
    setTheme(updated);
    localStorage.setItem(THEME_KEY, JSON.stringify(updated));
  }

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

  if (!currentChapter || !book) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="w-8 h-8 text-indigo-600" />
      </div>
    );
  }

  const text = chapterText?.text_content;

  return (
    <div className="max-w-3xl mx-auto">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-4 gap-3">
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
          <span className="hidden sm:inline">{book.title}</span>
          <span className="sm:hidden">Quay lại</span>
        </Link>

        <div className="flex items-center gap-2">
          {/* Listen link */}
          <Link
            href={`/listen?id=${bookId}&chapter=${chapterId}`}
            className="flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-950 transition-colors"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" />
            </svg>
            Nghe
          </Link>

          {/* Settings toggle */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-2 rounded-lg transition-colors ${
              showSettings
                ? "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
                : "text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800"
            }`}
            title="Cài đặt đọc"
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
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="mb-4 p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm animate-in space-y-4">
          {/* Font size */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Cỡ chữ
            </span>
            <div className="flex items-center gap-1.5">
              {FONT_SIZES.map((size) => (
                <button
                  key={size}
                  onClick={() => handleFontSize(size)}
                  className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                    fontSize === size
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          {/* Font family */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Phông chữ
            </span>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              {FONT_FAMILIES.map((ff) => (
                <button
                  key={ff.value}
                  onClick={() => handleFontFamily(ff.value)}
                  className={`px-2.5 h-8 rounded-lg text-xs font-medium transition-colors ${
                    fontFamily === ff.value
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                  }`}
                  style={{ fontFamily: ff.value }}
                >
                  {ff.label}
                </button>
              ))}
            </div>
          </div>

          {/* Theme presets */}
          <div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
              Giao diện đọc
            </span>
            <div className="grid grid-cols-6 gap-2">
              {READER_THEMES.map((t) => (
                <button
                  key={t.name}
                  onClick={() => handleTheme(t)}
                  className={`flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all ${
                    theme.name === t.name
                      ? "border-indigo-500 shadow-sm"
                      : "border-transparent hover:border-gray-300 dark:hover:border-gray-600"
                  }`}
                >
                  <div
                    className="w-full aspect-square rounded-lg flex items-center justify-center text-xs font-bold shadow-inner"
                    style={{ backgroundColor: t.bg, color: t.text }}
                  >
                    Aa
                  </div>
                  <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400">
                    {t.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Custom color pickers */}
          <div className="flex items-center gap-4 pt-2 border-t border-gray-100 dark:border-gray-700">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Màu chữ
              </label>
              <input
                type="color"
                value={customText}
                onChange={(e) => handleCustomColor("text", e.target.value)}
                className="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-600 cursor-pointer bg-transparent"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Màu nền
              </label>
              <input
                type="color"
                value={customBg}
                onChange={(e) => handleCustomColor("bg", e.target.value)}
                className="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-600 cursor-pointer bg-transparent"
              />
            </div>
            <div
              className="ml-auto flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700"
              style={{ backgroundColor: theme.bg }}
            >
              <span
                className="text-xs font-medium"
                style={{ color: theme.text }}
              >
                Xem trước
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Chapter header */}
      <div className="mb-6 pb-4 border-b border-gray-200 dark:border-gray-700">
        <p className="text-xs font-medium text-indigo-500 dark:text-indigo-400 mb-1 uppercase tracking-wider">
          Chương {currentChapter.chapter_index + 1} / {allChapters.length}
        </p>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 leading-tight">
          {currentChapter.title}
        </h1>
        <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
          {currentChapter.word_count.toLocaleString()} từ
        </p>
      </div>

      {/* Reading content */}
      <div
        ref={contentRef}
        className="min-h-[50vh] rounded-2xl px-5 sm:px-8 py-6 transition-colors duration-300"
        style={{ backgroundColor: theme.bg }}
      >
        {isLoadingText ? (
          <div
            className="flex flex-col items-center gap-3 py-20"
            style={{ color: theme.text, opacity: 0.5 }}
          >
            <Spinner className="w-7 h-7" />
            <p className="text-sm">Đang tải nội dung...</p>
          </div>
        ) : text ? (
          <article
            className="reader-content pb-8"
            style={{ fontSize: `${fontSize}px`, fontFamily: fontFamily }}
          >
            {text.split(/\n+/).map((para, i) =>
              para.trim() ? (
                <p
                  key={i}
                  className="mb-4 last:mb-0"
                  style={{ lineHeight: 1.8, color: theme.text }}
                >
                  {para.trim()}
                </p>
              ) : null,
            )}
          </article>
        ) : (
          <div
            className="flex flex-col items-center gap-3 py-20"
            style={{ color: theme.text, opacity: 0.4 }}
          >
            <svg
              className="w-12 h-12"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <p className="text-sm">Không có nội dung cho chương này.</p>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div className="sticky bottom-0 bg-gray-50/80 dark:bg-gray-950/80 backdrop-blur-sm border-t border-gray-200 dark:border-gray-700 -mx-4 px-4 py-3 mt-8">
        <div className="flex items-center justify-between max-w-3xl mx-auto">
          <button
            onClick={() => prevChapter && navigateTo(prevChapter)}
            disabled={!prevChapter}
            className="flex items-center gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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
            Chương trước
          </button>

          {/* Chapter dropdown */}
          <select
            value={chapterId}
            onChange={(e) => {
              const ch = allChapters.find((c) => c.id === e.target.value);
              if (ch) navigateTo(ch);
            }}
            className="text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-gray-700 dark:text-gray-300 max-w-50 truncate focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
          >
            {allChapters.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.chapter_index + 1}. {ch.title}
              </option>
            ))}
          </select>

          <button
            onClick={() => nextChapter && navigateTo(nextChapter)}
            disabled={!nextChapter}
            className="flex items-center gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Chương tiếp
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
      </div>
    </div>
  );
}
