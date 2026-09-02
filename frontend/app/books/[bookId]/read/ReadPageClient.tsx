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
  canUseCachedChapterText,
} from "@/lib/chapterTextCache";
import {
  getOfflineChapter,
  getOfflineChapterIds,
  saveOfflineChapterText,
} from "@/lib/offlineRepository";
import {
  getCachedBook,
  cacheBook,
  getCachedAllChapters,
  cacheAllChapters,
} from "@/lib/bookCache";
import { acquireScreenWake, releaseScreenWake } from "@/lib/backgroundLock";
import type { Chapter } from "@/types";
import { Sheet } from "@/components/ui/Sheet";
import { IconButton } from "@/components/ui/Button";
import {
  DEFAULT_READER_PREFERENCES,
  contrastRatio,
  loadReaderPreferences,
  saveReaderPreferences,
  type ReaderPreferences,
  type ReaderTheme,
} from "@/lib/readerPreferences";

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

/**
 * Offline-first chapter text fetch through the shared repository. Android
 * reads app-private native files; web uses IndexedDB.
 *
 * `knownServerUpdatedAt`, when available (from the already-loaded chapters
 * list), lets a cached entry be invalidated the moment it's known stale —
 * e.g. an admin edited the chapter — instead of waiting out the TTL below.
 * Without it (chapters list not loaded yet, or an old cache entry from
 * before this field existed) the TTL-based stale-while-revalidate check is
 * the fallback.
 */
async function fetchChapterTextOfflineFirst(
  bookId: string,
  chapterId: string,
  knownServerUpdatedAt?: string,
) {
  const cached = await getOfflineChapter(bookId, chapterId);
  if (cached && !canUseCachedChapterText(cached, knownServerUpdatedAt)) {
    // Online and (known-stale or version-unknown) — try to get the current
    // text now rather than waiting on the TTL. Any failure (offline, flaky
    // connection) falls through to serve the cache below, same as always.
    try {
      const res = await api.getChapterText(chapterId);
      if (res?.text_content) {
        void saveOfflineChapterText(
          bookId,
          chapterId,
          res.text_content,
          res.updated_at,
        ).catch(() => {});
      }
      return res;
    } catch {
      // fall through
    }
  }
  if (cached) {
    const fresh = Date.now() - cached.cached_at < CHAPTER_TEXT_TTL_MS;
    if (!fresh) {
      // Stale-while-revalidate: serve cached now, refresh in the background.
      api
        .getChapterText(chapterId)
        .then((res) => {
          if (res?.text_content && res.text_content !== cached.text_content) {
            void saveOfflineChapterText(
              bookId,
              chapterId,
              res.text_content,
              res.updated_at,
            ).catch(() => {});
          }
        })
        .catch(() => {});
    }
    return { id: chapterId, text_content: cached.text_content };
  }
  const res = await api.getChapterText(chapterId);
  if (res?.text_content) {
    void saveOfflineChapterText(
      bookId,
      chapterId,
      res.text_content,
      res.updated_at,
    ).catch(() => {});
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

  const [preferences, setPreferences] = useState<ReaderPreferences>(
    loadReaderPreferences,
  );
  const {
    fontSize,
    fontFamily,
    theme,
    customText,
    customBg,
    lineHeight,
    contentWidth,
  } = preferences;
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
    staleTime: 10 * 60_000,
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
    // Same policy as ListenPageClient's all-chapters query: admin edits
    // invalidate explicitly, foreground invalidation still refetches, and the
    // long gcTime keeps the big list cached across read↔listen switches.
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
  });

  const { data: chapterText, isLoading: isLoadingText } = useQuery({
    queryKey: ["chapterText", chapterId],
    queryFn: () =>
      fetchChapterTextOfflineFirst(
        bookId,
        chapterId!,
        chaptersData?.items.find((c) => c.id === chapterId)?.updated_at,
      ),
    enabled: !!chapterId,
  });

  // Fetch saved reading progress — falls back to offline queue.
  // Use getBookProgress (one row per book) and only restore if it's for THIS chapter.
  // getChapterProgress queries by chapter_id but the DB stores only the latest chapter
  // per book, so it returns null for any chapter that isn't the most recently visited.
  const { data: savedProgress } = useQuery({
    queryKey: ["progress", bookId, chapterId],
    queryFn: async () => {
      // IndexedDB position in the UserProgress response shape — the offline
      // fallback for accounts, and the ONLY store guests have.
      const fromLocal = async () => {
        const queued = await getLocalProgress(chapterId!);
        if (!queued) return null;
        return {
          id: "",
          user_id: "",
          book_id: queued.book_id,
          chapter_id: queued.chapter_id,
          progress_value: queued.progress_value,
          total_value: queued.total_value,
          updated_at: new Date(queued.updated_at).toISOString(),
        };
      };
      if (!isLoggedIn()) return fromLocal();
      try {
        const progress = await api.getBookProgress(bookId);
        if (progress?.chapter_id === chapterId) return progress;
        return null;
      } catch {
        return fromLocal();
      }
    },
    enabled: !!chapterId,
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
        queryFn: () =>
          fetchChapterTextOfflineFirst(bookId, ch.id, ch.updated_at),
      });
    }
  }, [bookId, chapterText, allChapters, currentIndex, queryClient]);

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
    setPreferences((current) => {
      const next = { ...current, fontSize: size };
      saveReaderPreferences(next);
      return next;
    });
  }

  function handleFontFamily(ff: string) {
    setPreferences((current) => {
      const next = { ...current, fontFamily: ff };
      saveReaderPreferences(next);
      return next;
    });
  }

  function handleTheme(t: ReaderTheme) {
    setPreferences((current) => {
      const next = {
        ...current,
        theme: t,
        customText: t.text,
        customBg: t.bg,
      };
      saveReaderPreferences(next);
      return next;
    });
  }

  function handleCustomColor(type: "text" | "bg", color: string) {
    const candidateText = type === "text" ? color : customText;
    const candidateBg = type === "bg" ? color : customBg;
    const updated = {
      ...theme,
      name: "custom",
      label: "Tùy chọn",
      text: candidateText,
      bg: candidateBg,
    };
    setPreferences((current) => {
      const next = {
        ...current,
        customText: candidateText,
        customBg: candidateBg,
        // Keep the currently readable palette active until the candidate
        // reaches WCAG AA contrast.
        theme:
          contrastRatio(candidateText, candidateBg) >= 4.5
            ? updated
            : current.theme,
      };
      saveReaderPreferences(next);
      return next;
    });
  }

  function updateReaderLayout(
    field: "lineHeight" | "contentWidth",
    value: number,
  ) {
    setPreferences((current) => {
      const next = { ...current, [field]: value };
      saveReaderPreferences(next);
      return next;
    });
  }

  const customContrast = contrastRatio(customText, customBg);

  // Refresh cached-chapter IDs when the TOC drawer opens.
  useEffect(() => {
    if (!showToc) return;
    let alive = true;
    void getOfflineChapterIds(bookId).then((ids) => {
      if (alive) setCachedIds(new Set(ids));
    });
    return () => {
      alive = false;
    };
  }, [bookId, showToc]);

  // Chapter navigation is buttons only -- see the bottom bar. Swipe and
  // edge-tap used to live here and both fired during ordinary scrolling: a
  // thumb flick arcs far enough sideways to read as a swipe, and a tap to halt
  // momentum scrolling is identical to an edge tap. No amount of threshold
  // tuning separates them reliably from a scroll, so the gestures are gone.

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
      className="-mx-4 sm:-mx-6 -my-2 px-3 sm:px-6 min-h-[calc(100dvh-3.5rem)] transition-colors duration-300"
      style={{
        backgroundColor: effectiveTheme.bg,
        color: effectiveTheme.text,
        paddingTop: "calc(var(--sat) + 0.5rem)",
        // Clears the fixed nav bar so the last lines are never hidden behind it.
        paddingBottom: "calc(5rem + var(--sab))",
        overscrollBehaviorY: "contain",
      }}
    >
      <div className="mx-auto" style={{ maxWidth: `${contentWidth}rem` }}>
      {/* Reading progress bar (sits below the system status bar) */}
      <div
        className="sticky top-0 z-20 h-0.5 bg-transparent"
        role="progressbar"
        aria-label={`Tiến độ đọc: ${Math.round(scrollPct)} phần trăm`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(scrollPct)}
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
          className="-ml-2 inline-flex size-11 items-center justify-center rounded-full transition-[color,background-color,transform] hover:bg-current/5 hover:text-accent active:scale-[0.96]"
          style={{ color: effectiveTheme.text }}
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
        <p
          className="truncate text-center font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: effectiveTheme.text, opacity: 0.7 }}
        >
          Chương {currentChapter.chapter_index + 1} ·{" "}
          <span className="text-accent">{Math.round(scrollPct)}%</span>
        </p>
        <IconButton
          onClick={() => setShowSettings(!showSettings)}
          label="Cài đặt đọc"
          className={`-mr-2 ${showSettings ? "text-accent" : "hover:text-accent"}`}
          style={{ color: showSettings ? undefined : effectiveTheme.text }}
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
        </IconButton>
      </div>

      <Sheet
        open={showSettings}
        onClose={() => setShowSettings(false)}
        title="Cài đặt đọc"
        description="Chữ, màu và chiều rộng nội dung"
      >
        <div className="space-y-5">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-text-dim">Cỡ chữ</legend>
            <div className="grid grid-cols-6 gap-1.5">
              {FONT_SIZES.map((size) => (
                <button
                  type="button"
                  key={size}
                  onClick={() => handleFontSize(size)}
                  className={`min-h-11 rounded-lg text-xs font-medium transition-[color,background-color,transform] active:scale-[0.96] ${
                    fontSize === size
                      ? "bg-accent text-ink"
                      : "bg-raised text-text-dim hover:bg-raised-hi"
                  }`}
                  aria-pressed={fontSize === size}
                >
                  {size}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-text-dim">Phông chữ</legend>
            <div className="flex flex-wrap gap-1.5">
              {FONT_FAMILIES.map((ff) => (
                <button
                  type="button"
                  key={ff.value}
                  onClick={() => handleFontFamily(ff.value)}
                  className={`min-h-11 rounded-lg px-3 text-xs font-medium transition-[color,background-color,transform] active:scale-[0.96] ${
                    fontFamily === ff.value
                      ? "bg-accent text-ink"
                      : "bg-raised text-text-dim hover:bg-raised-hi"
                  }`}
                  style={{ fontFamily: ff.value }}
                  aria-pressed={fontFamily === ff.value}
                >
                  {ff.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-text-dim">
              Giãn dòng <span className="font-mono text-xs text-text-faint">{lineHeight.toFixed(1)}</span>
              <input
                type="range"
                min="1.4"
                max="2.2"
                step="0.1"
                value={lineHeight}
                onChange={(event) => updateReaderLayout("lineHeight", Number(event.target.value))}
                className="mt-2 h-11 w-full"
              />
            </label>
            <label className="block text-sm font-semibold text-text-dim">
              Chiều rộng <span className="font-mono text-xs text-text-faint">{contentWidth} rem</span>
              <input
                type="range"
                min="32"
                max="64"
                step="2"
                value={contentWidth}
                onChange={(event) => updateReaderLayout("contentWidth", Number(event.target.value))}
                className="mt-2 h-11 w-full"
              />
            </label>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-text-dim">Giao diện đọc</legend>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
              {READER_THEMES.map((preset) => {
                const swatch =
                  preset.name === "auto"
                    ? systemDark
                      ? AUTO_DARK
                      : AUTO_LIGHT
                    : preset;
                return (
                  <button
                    type="button"
                    key={preset.name}
                    onClick={() => handleTheme(preset)}
                    className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border p-2 transition-[border-color,background-color,transform] active:scale-[0.96] ${
                      theme.name === preset.name
                        ? "border-accent bg-accent/10"
                        : "border-hairline-soft hover:border-hairline"
                    }`}
                    aria-pressed={theme.name === preset.name}
                  >
                    <span
                      className="flex size-8 items-center justify-center rounded-lg text-xs font-bold shadow-inner"
                      style={{ backgroundColor: swatch.bg, color: swatch.text }}
                    >
                      Aa
                    </span>
                    <span className="text-[10px] font-medium text-text-mute">{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="border-t border-hairline-soft pt-4">
            <legend className="px-1 text-sm font-semibold text-text-dim">Màu tùy chọn</legend>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-text-mute">
                Màu chữ
                <input
                  type="color"
                  value={customText}
                  onChange={(event) => handleCustomColor("text", event.target.value)}
                  className="size-11 cursor-pointer rounded-lg border border-hairline bg-transparent"
                />
              </label>
              <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-text-mute">
                Màu nền
                <input
                  type="color"
                  value={customBg}
                  onChange={(event) => handleCustomColor("bg", event.target.value)}
                  className="size-11 cursor-pointer rounded-lg border border-hairline bg-transparent"
                />
              </label>
              <div
                className="ml-auto flex min-h-11 items-center rounded-lg border border-hairline px-4"
                style={{ backgroundColor: customBg, color: customText }}
              >
                <span className="text-xs font-semibold">Xem trước · {customContrast.toFixed(1)}:1</span>
              </div>
            </div>
            {customContrast < 4.5 && (
              <div className="mt-3 flex items-center gap-3 rounded-xl border border-gold/30 bg-gold/10 p-3 text-xs text-gold" role="alert">
                <span className="flex-1">Độ tương phản chưa đủ 4.5:1 nên màu này chưa được áp dụng.</span>
                <button
                  type="button"
                  onClick={() => {
                    setPreferences(DEFAULT_READER_PREFERENCES);
                    saveReaderPreferences(DEFAULT_READER_PREFERENCES);
                  }}
                  className="min-h-11 rounded-lg px-2 font-semibold underline underline-offset-2"
                >
                  Đặt lại
                </button>
              </div>
            )}
          </fieldset>
        </div>
      </Sheet>

      {/* Chapter title — deliberately plain. The eyebrow, ❖ ornament and word
          count that used to sit here were decoration competing with the text,
          and the chapter number already shows in the top bar. Colour comes from
          the reader theme rather than the app palette so it doesn't clash on
          sepia / neon / warm. */}
      <h1
        className="mb-6 text-lg sm:text-xl font-semibold leading-snug text-balance"
        style={{ color: effectiveTheme.text }}
      >
        {currentChapter.title}
      </h1>

      {/* Reading content — no card; inherits the page's theme bg so the
          whole reader reads as one continuous surface. */}
      <div
        ref={contentRef}
        className="min-h-[50vh] py-2"
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
              // Every paragraph renders the same way. The first one used to get
              // a large accent-coloured drop cap, which drew the eye away from
              // the text instead of into it.
              return paragraphs.map((para, i) => {
                return (
                  <p
                    key={i}
                    className="mb-4 last:mb-0 text-pretty"
                    style={{
                      lineHeight,
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

      {/* Bottom nav bar — the only way to change chapters now, so it stays
          reachable mid-chapter rather than only at the end of the page.
          Fixed rather than sticky: sticky depends on the containing block and
          on no ancestor clipping overflow, and this bar sits outside the
          article wrapper. Fixed always works, at the cost of the page needing
          bottom padding to clear it (see the root element above).
          It is also opaque now — transparent let the text scroll through it.
          The hairline is neutral grey at low alpha so it reads correctly on
          every reader theme. */}
      <div
        className="fixed bottom-0 left-0 right-0 z-30 px-3"
        style={{
          paddingTop: "0.75rem",
          paddingBottom: "calc(0.75rem + var(--sab))",
          color: effectiveTheme.text,
          backgroundColor: effectiveTheme.bg,
          boxShadow:
            "0 -1px 0 0 rgba(128,128,128,0.2), 0 -10px 24px -14px rgba(0,0,0,0.45)",
        }}
      >
        <div className="flex items-stretch gap-2 max-w-3xl mx-auto">
          {/* Colours come from currentColor so the strip follows the reader
              theme (sepia, neon, warm) instead of the app's grey palette.
              min-h-11 keeps every target above the 44px touch minimum — the
              old chevrons were roughly 32px. */}
          <button
            onClick={() => prevChapter && navigateTo(prevChapter)}
            disabled={!prevChapter}
            className="flex items-center gap-1.5 shrink-0 min-h-11 px-3.5 rounded-xl bg-current/5 hover:bg-current/10 disabled:opacity-25 disabled:pointer-events-none active:scale-[0.96] transition-[transform,background-color] duration-150"
            aria-label={
              prevChapter
                ? `Chương ${prevChapter.chapter_index + 1}`
                : "Không có chương trước"
            }
          >
            <svg
              className="w-5 h-5 shrink-0"
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
            <span className="text-sm font-medium tabular-nums">
              <span className="hidden sm:inline">Chương </span>
              {prevChapter ? prevChapter.chapter_index + 1 : "—"}
            </span>
          </button>

          {/* Open searchable chapter list */}
          <button
            onClick={() => setShowToc(true)}
            className="flex-1 min-w-0 flex flex-col items-center justify-center min-h-11 px-3 rounded-xl border border-current/15 hover:bg-current/5 active:scale-[0.96] transition-[transform,background-color] duration-150"
            aria-label="Danh sách chương"
          >
            <span className="text-[11px] leading-none opacity-60 tabular-nums">
              {currentChapter.chapter_index + 1}
              {allChapters.length > 0 ? ` / ${allChapters.length}` : ""}
            </span>
            <span className="text-sm leading-tight mt-0.5 truncate max-w-full">
              {currentChapter.title}
            </span>
          </button>

          <button
            onClick={() => nextChapter && navigateTo(nextChapter)}
            disabled={!nextChapter}
            className="flex items-center gap-1.5 shrink-0 min-h-11 px-3.5 rounded-xl bg-current/5 hover:bg-current/10 disabled:opacity-25 disabled:pointer-events-none active:scale-[0.96] transition-[transform,background-color] duration-150"
            aria-label={
              nextChapter
                ? `Chương ${nextChapter.chapter_index + 1}`
                : "Không có chương tiếp"
            }
          >
            <span className="text-sm font-medium tabular-nums">
              <span className="hidden sm:inline">Chương </span>
              {nextChapter ? nextChapter.chapter_index + 1 : "—"}
            </span>
            <svg
              className="w-5 h-5 shrink-0"
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
        <Sheet
          open
          onClose={() => setShowToc(false)}
          title="Mục lục"
          description={`${allChapters.length} chương`}
        >
            <div className="pb-2">
              <input
                type="text"
                inputMode="search"
                autoFocus={!isNativePlatform()}
                value={tocSearch}
                onChange={(e) => setTocSearch(e.target.value)}
                placeholder="Tìm chương theo số hoặc tiêu đề..."
                className="min-h-11 w-full rounded-lg border border-hairline bg-ink px-3 py-2 text-base text-text-dim outline-none focus:border-accent focus:ring-2 focus:ring-accent"
              />
            </div>
            <div ref={tocScrollRef} className="h-[min(56dvh,32rem)] overflow-y-auto px-2 pb-2">
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
                        className={`absolute left-0 top-0 flex min-h-11 w-full select-none items-center gap-3 rounded-lg px-3 text-left transition-colors ${
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
        </Sheet>
      )}
      </div>
    </div>
  );
}
