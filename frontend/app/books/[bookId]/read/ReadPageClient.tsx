"use client";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "@/lib/api";
import { isLoggedIn } from "@/lib/auth";
import { isNativePlatform } from "@/lib/capacitor";
import { useProgressSync } from "@/hooks/useProgressSync";
import { Spinner } from "@/components/ui/Spinner";
import { getLocalProgress, saveLocalBookProgress } from "@/lib/progressQueue";
import {
  getCachedChapterEntry,
  cacheChapterText,
  getAllCachedChapterIds,
} from "@/lib/chapterTextCache";
import {
  getCachedBook,
  cacheBook,
  getCachedAllChapters,
  cacheAllChapters,
} from "@/lib/bookCache";
import { acquireScreenWake, releaseScreenWake } from "@/lib/backgroundLock";
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
  { name: "auto", bg: "#ffffff", text: "#1f2937", label: "Tự động" },
  { name: "light", bg: "#ffffff", text: "#1f2937", label: "Sáng" },
  { name: "sepia", bg: "#f5f0e8", text: "#5c4b37", label: "Sepia" },
  { name: "dark", bg: "#1a1a2e", text: "#e0e0e0", label: "Tối" },
  { name: "neon", bg: "#040714", text: "#22b80a", label: "Neon" },
  { name: "warm", bg: "#2d1b00", text: "#f5c882", label: "Ấm" },
  { name: "gray", bg: "#2a2a2a", text: "#cccccc", label: "Xám" },
];

// Theme used when "auto" matches a dark system preference.
const AUTO_DARK: Pick<ReaderTheme, "bg" | "text"> = {
  bg: "#1a1a2e",
  text: "#e0e0e0",
};
const AUTO_LIGHT: Pick<ReaderTheme, "bg" | "text"> = {
  bg: "#ffffff",
  text: "#1f2937",
};

// How long a cached chapter is considered fresh. Within this window we skip
// the silent background refresh — fully pre-downloaded books do zero network
// I/O on revisits. Chapter text is essentially immutable once published, so a
// generous TTL is fine; the user can pull a hard refresh by re-uploading the
// EPUB or clearing offline data.
const CHAPTER_TEXT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Offline-first chapter text fetch: try IndexedDB, fall through to API. */
async function fetchChapterTextOfflineFirst(chapterId: string) {
  const cached = await getCachedChapterEntry(chapterId);
  if (cached) {
    const fresh = Date.now() - cached.cached_at < CHAPTER_TEXT_TTL_MS;
    if (!fresh) {
      // Stale-while-revalidate: serve cached now, refresh in the background.
      api
        .getChapterText(chapterId)
        .then((res) => {
          if (res?.text_content && res.text_content !== cached.text_content) {
            void cacheChapterText(chapterId, res.text_content);
          }
        })
        .catch(() => {});
    }
    return { id: chapterId, text_content: cached.text_content };
  }
  const res = await api.getChapterText(chapterId);
  if (res?.text_content) {
    void cacheChapterText(chapterId, res.text_content);
  }
  return res;
}

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
  const [showToc, setShowToc] = useState(false);
  const [tocSearch, setTocSearch] = useState("");
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [systemDark, setSystemDark] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [scrollPct, setScrollPct] = useState(0);

  const queryClient = useQueryClient();

  const {
    data: book,
    isError: bookError,
  } = useQuery({
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

  const {
    data: chaptersData,
    isError: chaptersError,
  } = useQuery({
    queryKey: ["chapters", bookId, "all"],
    queryFn: async () => {
      try {
        const data = await api.getAllBookChapters(bookId);
        cacheAllChapters(bookId, data).catch(() => {});
        return data;
      } catch {
        const cached = await getCachedAllChapters(bookId);
        if (cached) return cached;
        throw new Error("offline");
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  const { data: chapterText, isLoading: isLoadingText } = useQuery({
    queryKey: ["chapterText", chapterId],
    queryFn: () => fetchChapterTextOfflineFirst(chapterId!),
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

  const allChapters = useMemo(
    () => chaptersData?.items ?? [],
    [chaptersData],
  );
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

  // Prefetch ±2 chapters' text into the offline-first cache so prev/next
  // feel instant. Skip on the web build to avoid burning cellular data —
  // mirrors the listen page's native-only prefetch policy.
  useEffect(() => {
    if (!isNativePlatform()) return;
    if (!chapterText || allChapters.length === 0 || currentIndex < 0) return;
    const targets = [
      currentIndex - 1,
      currentIndex + 1,
      currentIndex + 2,
    ].filter((i) => i >= 0 && i < allChapters.length);
    for (const i of targets) {
      const ch = allChapters[i];
      if (!ch) continue;
      void queryClient.prefetchQuery({
        queryKey: ["chapterText", ch.id],
        queryFn: () => fetchChapterTextOfflineFirst(ch.id),
      });
    }
  }, [chapterText, allChapters, currentIndex, queryClient]);

  // Keep the screen awake while the reader is mounted and visible.
  // Native-only; no-op on web. Releases on unmount or when the app is hidden.
  useEffect(() => {
    if (!isNativePlatform()) return;
    let active = true;
    void acquireScreenWake();
    const onVisibility = () => {
      if (document.hidden) {
        active = false;
        void releaseScreenWake();
      } else if (!active) {
        active = true;
        void acquireScreenWake();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void releaseScreenWake();
    };
  }, []);

  // Track system dark-mode preference for the "auto" theme.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // Resolve the user-picked theme into concrete bg/text colors. The "auto"
  // preset adopts the system color scheme dynamically.
  const effectiveTheme = useMemo<ReaderTheme>(() => {
    if (theme.name === "auto") {
      const palette = systemDark ? AUTO_DARK : AUTO_LIGHT;
      return { ...theme, bg: palette.bg, text: palette.text };
    }
    return theme;
  }, [theme, systemDark]);

  // Scroll to top on chapter change (or restore saved position).
  // Reset the visual progress bar via the "derived state on prop change"
  // pattern so it isn't done inside an effect.
  const restoredRef = useRef(false);
  const [lastChapterId, setLastChapterId] = useState(chapterId);
  if (chapterId !== lastChapterId) {
    setLastChapterId(chapterId);
    setScrollPct(0);
  }
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

  // Track scroll progress (also drives the top progress bar).
  useEffect(() => {
    if (!chapterId || !chapterText) return;
    const handleScroll = () => {
      const scrollMax =
        document.documentElement.scrollHeight - window.innerHeight;
      if (scrollMax <= 0) return;
      const pct = Math.min(
        100,
        Math.max(0, Math.round((window.scrollY / scrollMax) * 100)),
      );
      setScrollPct(pct);
      reportProgress(pct, 100);
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

  // Refresh cached-chapter IDs when the TOC drawer opens.
  useEffect(() => {
    if (!showToc) return;
    let alive = true;
    void getAllCachedChapterIds().then((ids) => {
      if (alive) setCachedIds(new Set(ids));
    });
    return () => {
      alive = false;
    };
  }, [showToc]);

  // Pointer-based swipe + edge-tap navigation. Pure DOM events, no library.
  const swipeStart = useRef<{ x: number; y: number; t: number } | null>(null);

  const onContentPointerDown = (e: React.PointerEvent) => {
    if (!e.isPrimary) return;
    swipeStart.current = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  };

  const onContentPointerUp = (e: React.PointerEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || !e.isPrimary) return;

    // Don't hijack a long-press text selection.
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (sel && sel.toString().length > 0) return;

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = e.timeStamp - start.t;

    // Horizontal swipe.
    if (dt < 500 && Math.abs(dx) > 60 && Math.abs(dy) < 40) {
      if (dx < 0 && nextChapter) navigateTo(nextChapter);
      else if (dx > 0 && prevChapter) navigateTo(prevChapter);
      return;
    }

    // Edge-tap: native only, clear tap (no movement, < 300ms).
    if (
      isNativePlatform() &&
      dt < 300 &&
      Math.abs(dx) < 10 &&
      Math.abs(dy) < 10
    ) {
      const w = window.innerWidth;
      const x = e.clientX;
      if (x < w * 0.2 && prevChapter) navigateTo(prevChapter);
      else if (x > w * 0.8 && nextChapter) navigateTo(nextChapter);
    }
  };

  // Filtered chapter list for the TOC search input.
  const filteredChapters = useMemo(() => {
    const q = tocSearch.trim().toLowerCase();
    if (!q) return allChapters;
    return allChapters.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        String(c.chapter_index + 1).includes(q),
    );
  }, [allChapters, tocSearch]);

  // Virtualize the TOC so a 2000-chapter book doesn't mount thousands of rows.
  const tocScrollRef = useRef<HTMLDivElement>(null);
  const tocActiveIndex = useMemo(
    () => filteredChapters.findIndex((c) => c.id === chapterId),
    [filteredChapters, chapterId],
  );
  const tocVirtualizer = useVirtualizer({
    count: filteredChapters.length,
    getScrollElement: () => tocScrollRef.current,
    estimateSize: () => 48,
    overscan: 8,
  });

  // Center the current chapter when the TOC opens.
  useEffect(() => {
    if (!showToc || tocActiveIndex < 0) return;
    const raf = requestAnimationFrame(() => {
      if (tocScrollRef.current) {
        tocVirtualizer.scrollToIndex(tocActiveIndex, { align: "center" });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [showToc, tocActiveIndex, tocVirtualizer]);

  if (!chapterId) {
    return (
      <div className="text-center py-24 text-text-mute">
        Không có chương nào được chọn.{" "}
        <Link href={`/book?id=${bookId}`} className="text-accent underline">
          Quay lại
        </Link>
      </div>
    );
  }

  // Offline with nothing cached: the queries reject ("offline") instead of
  // spinning forever. Show a retryable message + a way back.
  if (bookError || chaptersError) {
    return (
      <div className="text-center py-24 text-text-mute">
        Không thể tải nội dung. Vui lòng kiểm tra kết nối mạng và thử lại.{" "}
        <Link href={`/book?id=${bookId}`} className="text-accent underline">
          Quay lại
        </Link>
      </div>
    );
  }

  if (!currentChapter || !book) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="w-8 h-8 text-accent" />
      </div>
    );
  }

  const text = chapterText?.text_content;

  return (
    <div
      // One continuous surface — escape AppMain's horizontal padding so the
      // theme bg goes edge-to-edge on Android. The whole reader (top bar,
      // hero, content, handoff) sits on this single background.
      className="-mx-4 sm:-mx-6 -my-2 px-4 sm:px-6 min-h-[calc(100dvh-3.5rem)] transition-colors duration-300"
      style={{
        backgroundColor: effectiveTheme.bg,
        color: effectiveTheme.text,
        paddingTop: "calc(var(--sat) + 0.5rem)",
        overscrollBehaviorY: "contain",
      }}
    >
      <div className="max-w-3xl mx-auto">
      {/* Reading progress bar (sits below the system status bar) */}
      <div
        className="sticky top-0 z-20 h-0.5 bg-transparent"
        aria-hidden="true"
      >
        <div
          className="h-full bg-accent transition-[width] duration-150"
          style={{ width: `${scrollPct}%` }}
        />
      </div>

      {/* Top bar — back / "HỒI N · X%" / settings menu */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 mb-4">
        <Link
          href={`/book?id=${bookId}`}
          className="-ml-2 p-2 text-text hover:text-accent transition-colors"
          title={book.title}
          aria-label="Quay lại"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 6l-6 6 6 6"
            />
          </svg>
        </Link>
        <p className="text-center font-mono text-[10px] tracking-[0.18em] uppercase text-text-mute truncate">
          Chương {currentChapter.chapter_index + 1} ·{" "}
          <span className="text-accent">{Math.round(scrollPct)}%</span>
        </p>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`-mr-2 p-2 transition-colors ${
            showSettings ? "text-accent" : "text-text hover:text-accent"
          }`}
          title="Cài đặt đọc"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="mb-4 p-4 bg-surface dark:bg-raised rounded-xl border border-hairline-soft dark:border-hairline shadow-sm animate-in space-y-4">
          {/* Font size */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text-dim dark:text-text-faint">
              Cỡ chữ
            </span>
            <div className="flex items-center gap-1.5">
              {FONT_SIZES.map((size) => (
                <button
                  key={size}
                  onClick={() => handleFontSize(size)}
                  className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                    fontSize === size
                      ? "bg-accent text-white"
                      : "bg-raised dark:bg-raised-hi text-text-dim dark:text-text-faint hover:bg-raised-hi dark:hover:bg-hairline"
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          {/* Font family */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text-dim dark:text-text-faint">
              Phông chữ
            </span>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              {FONT_FAMILIES.map((ff) => (
                <button
                  key={ff.value}
                  onClick={() => handleFontFamily(ff.value)}
                  className={`px-2.5 h-8 rounded-lg text-xs font-medium transition-colors ${
                    fontFamily === ff.value
                      ? "bg-accent text-white"
                      : "bg-raised dark:bg-raised-hi text-text-dim dark:text-text-faint hover:bg-raised-hi dark:hover:bg-hairline"
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
            <span className="text-sm font-medium text-text-dim dark:text-text-faint mb-2 block">
              Giao diện đọc
            </span>
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
              {READER_THEMES.map((t) => {
                const swatch =
                  t.name === "auto"
                    ? systemDark
                      ? { bg: AUTO_DARK.bg, text: AUTO_DARK.text }
                      : { bg: AUTO_LIGHT.bg, text: AUTO_LIGHT.text }
                    : { bg: t.bg, text: t.text };
                return (
                  <button
                    key={t.name}
                    onClick={() => handleTheme(t)}
                    className={`flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all ${
                      theme.name === t.name
                        ? "border-accent shadow-sm"
                        : "border-transparent hover:border-hairline dark:hover:border-hairline"
                    }`}
                  >
                    <div
                      className="w-full aspect-square rounded-lg flex items-center justify-center text-xs font-bold shadow-inner"
                      style={{ backgroundColor: swatch.bg, color: swatch.text }}
                    >
                      Aa
                    </div>
                    <span className="text-[10px] font-medium text-text-mute dark:text-text-mute">
                      {t.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom color pickers */}
          <div className="flex items-center gap-4 pt-2 border-t border-hairline-soft dark:border-hairline">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-text-mute dark:text-text-mute">
                Màu chữ
              </label>
              <input
                type="color"
                value={customText}
                onChange={(e) => handleCustomColor("text", e.target.value)}
                className="w-8 h-8 rounded-lg border border-hairline-soft dark:border-hairline cursor-pointer bg-transparent"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-text-mute dark:text-text-mute">
                Màu nền
              </label>
              <input
                type="color"
                value={customBg}
                onChange={(e) => handleCustomColor("bg", e.target.value)}
                className="w-8 h-8 rounded-lg border border-hairline-soft dark:border-hairline cursor-pointer bg-transparent"
              />
            </div>
            <div
              className="ml-auto flex items-center gap-2 px-3 py-1.5 rounded-lg border border-hairline-soft dark:border-hairline"
              style={{ backgroundColor: effectiveTheme.bg }}
            >
              <span
                className="text-xs font-medium"
                style={{ color: effectiveTheme.text }}
              >
                Xem trước
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Chapter header — design pattern: mono eyebrow / display title / hairline + ❖ ornament */}
      <div className="mb-6 text-center">
        <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-text-faint">
          Chương thứ {currentChapter.chapter_index + 1}
        </p>
        <h1 className="font-display text-2xl sm:text-3xl text-text leading-tight mt-2">
          {currentChapter.title}
        </h1>
        <div className="flex items-center justify-center gap-3 mt-3">
          <span className="h-px w-14 bg-hairline" />
          <span className="font-display text-sm text-accent">❖</span>
          <span className="h-px w-14 bg-hairline" />
        </div>
        <p className="font-mono text-[10px] tracking-widest uppercase text-text-faint mt-2">
          {currentChapter.word_count.toLocaleString()} từ · {allChapters.length}{" "}
          chương
        </p>
      </div>

      {/* Reading content — no card; inherits the page's theme bg so the
          whole reader reads as one continuous surface. */}
      <div
        ref={contentRef}
        className="min-h-[50vh] py-2 touch-pan-y"
        onPointerDown={onContentPointerDown}
        onPointerUp={onContentPointerUp}
      >
        {isLoadingText ? (
          <div
            className="space-y-4 py-4 animate-pulse"
            style={{ color: effectiveTheme.text }}
            aria-label="Đang tải nội dung"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="rounded-md"
                style={{
                  height: `${fontSize * 1.8}px`,
                  width: `${[100, 96, 92, 88, 95, 70][i]}%`,
                  backgroundColor: effectiveTheme.text,
                  opacity: 0.08,
                }}
              />
            ))}
          </div>
        ) : text ? (
          <article
            className="reader-content pb-8"
            style={{ fontSize: `${fontSize}px`, fontFamily: fontFamily }}
          >
            {(() => {
              const paragraphs = text
                .split(/\n+/)
                .map((p) => p.trim())
                .filter(Boolean);
              return paragraphs.map((para, i) => {
                if (i === 0) {
                  // Drop-cap on first paragraph — design pattern
                  const first = para.charAt(0);
                  const rest = para.slice(1);
                  return (
                    <p
                      key={i}
                      className="mb-4"
                      style={{
                        lineHeight: 1.8,
                        color: effectiveTheme.text,
                        textIndent: 0,
                      }}
                    >
                      <span
                        className="font-display float-left mr-2 mt-1.5"
                        style={{
                          fontSize: `${fontSize * 3.2}px`,
                          lineHeight: 0.9,
                          color: "var(--color-accent)",
                          fontWeight: 600,
                        }}
                      >
                        {first}
                      </span>
                      {rest}
                    </p>
                  );
                }
                return (
                  <p
                    key={i}
                    className="mb-4 last:mb-0"
                    style={{
                      lineHeight: 1.8,
                      color: effectiveTheme.text,
                      textIndent: "1.5em",
                    }}
                  >
                    {para}
                  </p>
                );
              });
            })()}
          </article>
        ) : (
          <div
            className="flex flex-col items-center gap-3 py-20"
            style={{ color: effectiveTheme.text, opacity: 0.4 }}
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

      {/* Listen handoff — inherits the theme bg, only a subtle hairline */}
      <div className="mt-6 mb-2">
        <Link
          href={`/listen?id=${bookId}&chapter=${chapterId}`}
          className="flex items-center gap-3 p-3 rounded-md ring-1 ring-current/15 hover:ring-accent/40 transition-colors group"
          style={{ color: effectiveTheme.text }}
        >
          <span className="w-9 h-9 rounded-md bg-accent/15 ring-1 ring-accent/30 flex items-center justify-center text-accent shrink-0">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2a5 5 0 0 1-10 0H5z" />
            </svg>
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Chuyển sang nghe?</p>
            <p
              className="font-mono text-[10px] tracking-widest uppercase mt-0.5"
              style={{ opacity: 0.55 }}
            >
              Đọc tiếp bằng giọng hệ thống từ vị trí hiện tại
            </p>
          </div>
          <span className="bg-accent text-ink font-semibold text-xs px-3.5 py-2 rounded-sm shadow-[0_0_18px_var(--color-accent-glow)] shrink-0 group-hover:bg-accent-dim transition-colors">
            Nghe →
          </span>
        </Link>
      </div>

      {/* Bottom nav strip — transparent, inherits the page bg */}
      <div
        className="sticky bottom-0 -mx-4 px-4 mt-8 border-t border-current/10"
        style={{
          paddingTop: "0.75rem",
          paddingBottom: "calc(0.75rem + var(--sab))",
          color: effectiveTheme.text,
        }}
      >
        <div className="flex items-center justify-between gap-2 max-w-3xl mx-auto">
          <button
            onClick={() => prevChapter && navigateTo(prevChapter)}
            disabled={!prevChapter}
            className="flex items-center gap-1.5 px-3 py-2 -ml-2 rounded-lg text-sm font-medium text-text-dim dark:text-text-mute hover:text-accent dark:hover:text-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Chương trước"
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
            <span className="hidden sm:inline">Chương trước</span>
          </button>

          {/* Open searchable chapter list */}
          <button
            onClick={() => setShowToc(true)}
            className="flex-1 min-w-0 flex items-center justify-center gap-1.5 text-sm bg-surface dark:bg-raised border border-hairline-soft dark:border-hairline rounded-lg px-3 py-2 text-text-dim dark:text-text-faint hover:border-accent/40 dark:hover:border-accent transition-colors"
          >
            <svg
              className="w-4 h-4 shrink-0 text-text-mute"
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
            <span className="truncate">
              {currentChapter.chapter_index + 1}. {currentChapter.title}
            </span>
          </button>

          <button
            onClick={() => nextChapter && navigateTo(nextChapter)}
            disabled={!nextChapter}
            className="flex items-center gap-1.5 px-3 py-2 -mr-2 rounded-lg text-sm font-medium text-text-dim dark:text-text-mute hover:text-accent dark:hover:text-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Chương tiếp"
          >
            <span className="hidden sm:inline">Chương tiếp</span>
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

      {/* TOC drawer */}
      {showToc && (
        <div
          className={`fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 ${
            isNativePlatform() ? "" : "backdrop-blur-sm"
          }`}
          onClick={() => setShowToc(false)}
        >
          <div
            className="bg-surface dark:bg-surface w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-xl flex flex-col max-h-[80vh] sm:max-h-[70vh]"
            style={{ paddingBottom: "var(--sab)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <h2 className="text-base font-semibold text-text dark:text-text">
                Mục lục
              </h2>
              <button
                onClick={() => setShowToc(false)}
                className="p-1.5 rounded-lg text-text-mute hover:bg-raised dark:hover:bg-raised"
                aria-label="Đóng"
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
            <div className="px-4 pb-2">
              <input
                type="text"
                inputMode="search"
                autoFocus={!isNativePlatform()}
                value={tocSearch}
                onChange={(e) => setTocSearch(e.target.value)}
                placeholder="Tìm chương theo số hoặc tiêu đề..."
                className="w-full text-base bg-ink dark:bg-raised border border-hairline-soft dark:border-hairline rounded-lg px-3 py-2 text-text-dim dark:text-text-dim focus:ring-2 focus:ring-accent focus:border-accent outline-none"
              />
            </div>
            <div ref={tocScrollRef} className="flex-1 overflow-y-auto px-2 pb-2">
              {filteredChapters.length === 0 ? (
                <p className="text-center text-sm text-text-mute py-8">
                  Không tìm thấy chương nào.
                </p>
              ) : (
                <div
                  style={{
                    height: tocVirtualizer.getTotalSize(),
                    position: "relative",
                  }}
                >
                  {tocVirtualizer.getVirtualItems().map((vi) => {
                    const ch = filteredChapters[vi.index];
                    const isCurrent = ch.id === chapterId;
                    const isCached = cachedIds.has(ch.id);
                    return (
                      <button
                        key={ch.id}
                        onClick={() => {
                          setShowToc(false);
                          setTocSearch("");
                          navigateTo(ch);
                        }}
                        style={{
                          height: vi.size,
                          transform: `translateY(${vi.start}px)`,
                        }}
                        className={`absolute left-0 top-0 w-full flex items-center gap-3 px-3 text-left rounded-lg select-none transition-colors ${
                          isCurrent
                            ? "bg-accent/15 dark:bg-accent/40 text-accent-dim dark:text-accent"
                            : "text-text-dim dark:text-text-faint hover:bg-ink dark:hover:bg-raised"
                        }`}
                      >
                        <span
                          className={`shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-semibold ${
                            isCurrent
                              ? "bg-accent text-white"
                              : "bg-raised dark:bg-raised text-text-mute dark:text-text-mute"
                          }`}
                        >
                          {ch.chapter_index + 1}
                        </span>
                        <span className="flex-1 min-w-0 text-sm truncate">
                          {ch.title}
                        </span>
                        {isCached && (
                          <svg
                            className="w-4 h-4 shrink-0 text-accent"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            aria-label="Đã lưu offline"
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
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
