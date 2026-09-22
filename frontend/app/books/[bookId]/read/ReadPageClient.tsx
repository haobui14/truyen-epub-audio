"use client";
import {
  memo,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
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
import { ActionButton, IconButton } from "@/components/ui/Button";
import { usePlayerContext } from "@/context/PlayerContext";
import {
  CONTENT_WIDTH,
  DEFAULT_READER_PREFERENCES,
  contrastRatio,
  loadReaderPreferences,
  saveReaderPreferences,
  type ReaderPreferences,
  type ReaderTheme,
} from "@/lib/readerPreferences";
import {
  setReaderChromeHidden,
  toggleReaderChromeHidden,
  useReaderChromeHidden,
} from "@/lib/readerChrome";

/**
 * Track actual reading engagement and award XP when the user has spent
 * enough time actively reading the chapter (visible page, not just loaded).
 * Threshold: max(15s, wordCount / 300 * 60 * 0.35) seconds, capped at 90s.
 */
// On the web the reader scrolls the page. On Android it scrolls its own box
// (see the scroller in ReadPage), because the page-level scrollbar is drawn by
// the Android WebView itself: it ran the full screen height, behind the status
// bar and the chapter bar, and no CSS can shorten it. `null` means the page.
type Scroller = HTMLElement | null;

function scrollMetrics(el: Scroller) {
  return el
    ? { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }
    : {
        top: window.scrollY,
        max: document.documentElement.scrollHeight - window.innerHeight,
      };
}

// Finger travel past the end of a chapter that opens the next one, and how far
// the text lifts with it (damped to half the travel, then capped).
const PULL_THRESHOLD = 80;
const PULL_MAX_SHIFT = 56;

function scrollToY(el: Scroller, top: number) {
  (el ?? window).scrollTo({ top, behavior: "auto" });
}

function listenScroll(el: Scroller, handler: () => void) {
  const target: HTMLElement | Window = el ?? window;
  target.addEventListener("scroll", handler, { passive: true });
  return () => target.removeEventListener("scroll", handler);
}

function useReadingXp(
  chapterId: string | null,
  bookId: string,
  wordCount: number,
  hasText: boolean,
  scrollerRef: React.RefObject<HTMLDivElement | null>,
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
    const el = scrollerRef.current;
    const onScroll = () => {
      const { top, max } = scrollMetrics(el);
      if (max <= 0) return;
      if (top / max > 0.25) scrolledPastRef.current = true;
    };
    return listenScroll(el, onScroll);
  }, [hasText, chapterId, scrollerRef]);

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

const ReaderArticle = memo(function ReaderArticle({
  text,
  fontSize,
  fontFamily,
  lineHeight,
  textColor,
}: {
  text: string;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  textColor: string;
}) {
  const paragraphs = useMemo(
    () =>
      text
        .split(/\n+/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean),
    [text],
  );

  return (
    <article
      className="reader-content pb-8"
      style={{ fontSize: `${fontSize}px`, fontFamily }}
      lang="vi"
      aria-labelledby="reader-chapter-title"
    >
      {paragraphs.map((paragraph, index) => (
        <p
          key={index}
          className="mb-4 last:mb-0"
          style={{
            lineHeight,
            color: textColor,
            textIndent: "1.5em",
          }}
        >
          {paragraph}
        </p>
      ))}
    </article>
  );
});

function ReaderPlayerClearance() {
  const { session } = usePlayerContext();
  if (!session.active) return null;
  return <div className="h-14" aria-hidden="true" />;
}

export default function ReadPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const bookId = (searchParams.get("id") ||
    (params?.bookId as string) ||
    "") as string;
  const chapterId = searchParams.get("chapter");
  const router = useRouter();
  const contentRef = useRef<HTMLDivElement>(null);
  // Android only; stays null on the web, where the page itself scrolls.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const nativeScroll = isNativePlatform();

  // Android: the text box does the scrolling, so the page itself must not.
  // Even a few pixels of page overflow would bring back the WebView's
  // full-height scrollbar. Restored on leaving the reader.
  useEffect(() => {
    if (!nativeScroll) return;
    const html = document.documentElement;
    const previous = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = previous;
    };
  }, [nativeScroll]);

  // Immersive reading: a tap on the text hides or shows the top bar, the
  // chapter bar and the mini player together. Always leave the reader with
  // them visible, so no other page inherits a hidden mini player.
  const chromeHidden = useReaderChromeHidden();
  const tapTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (tapTimerRef.current !== null) window.clearTimeout(tapTimerRef.current);
      setReaderChromeHidden(false);
    },
    [],
  );
  const handleReaderTap = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    // Controls, the sheets, and the bars themselves keep their own meaning.
    if (
      target.closest(
        "a, button, input, textarea, select, label, [role='dialog'], [data-reader-chrome]",
      )
    ) {
      return;
    }
    // Ending a long-press or drag selection must not toggle the bars.
    if (window.getSelection()?.isCollapsed === false) return;
    const pointerType = (event.nativeEvent as PointerEvent).pointerType;
    if (pointerType === "touch" || pointerType === "pen") {
      toggleReaderChromeHidden();
      return;
    }
    // Mouse: a double-click selects a word, and its first click must not
    // flicker the bars. Wait long enough to see whether a second one follows.
    if (tapTimerRef.current !== null) {
      window.clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
      return;
    }
    tapTimerRef.current = window.setTimeout(() => {
      tapTimerRef.current = null;
      if (window.getSelection()?.isCollapsed === false) return;
      toggleReaderChromeHidden();
    }, 250);
  }, []);

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
    refetch: refetchBook,
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
    refetch: refetchChapters,
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

  const {
    data: chapterText,
    isLoading: isLoadingText,
    isError: chapterTextError,
    isFetching: isFetchingText,
    refetch: refetchChapterText,
  } = useQuery({
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
    scrollerRef,
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

  // Pull up past the end of a chapter to open the next one. Painted straight
  // onto the DOM through refs: a React state update per touchmove would
  // re-render a several-thousand-paragraph chapter at 60 Hz. React state only
  // flips when the pull crosses the threshold, to swap the hint text.
  const pullTargetRef = useRef<HTMLDivElement | null>(null);
  const pullFillRef = useRef<HTMLDivElement | null>(null);
  const [pullArmed, setPullArmed] = useState(false);
  const hasChapterText = !!chapterText?.text_content;
  useEffect(() => {
    if (!hasChapterText || !nextChapter) return;
    const el = scrollerRef.current;
    const target: HTMLElement | Window = el ?? window;
    let active = false;
    let anchorY: number | null = null;
    let distance = 0;
    let armed = false;

    const atBottom = () => {
      const { top, max } = scrollMetrics(el);
      return max <= 0 || top >= max - 2;
    };
    const paint = (d: number) => {
      const wrapper = pullTargetRef.current;
      if (wrapper) {
        wrapper.style.transform = d > 0 ? `translateY(${-Math.min(d * 0.5, PULL_MAX_SHIFT)}px)` : "";
      }
      if (pullFillRef.current) {
        pullFillRef.current.style.width = `${Math.min(100, (d / PULL_THRESHOLD) * 100)}%`;
      }
      const nowArmed = d >= PULL_THRESHOLD;
      if (nowArmed !== armed) {
        armed = nowArmed;
        setPullArmed(nowArmed);
      }
    };
    const reset = () => {
      anchorY = null;
      distance = 0;
      paint(0);
    };

    const onStart = (event: Event) => {
      const touch = event as TouchEvent;
      // Drags inside the settings or chapter-list sheets are theirs.
      active =
        touch.touches.length === 1 &&
        !(touch.target as Element | null)?.closest?.("[role='dialog']");
      reset();
    };
    const onMove = (event: Event) => {
      if (!active) return;
      const y = (event as TouchEvent).touches[0]?.clientY;
      if (y === undefined) return;
      if (!atBottom()) {
        // Scrolled back up into the chapter: this is reading, not a pull.
        reset();
        return;
      }
      // Anchor where the finger was when the end was reached, so a drag that
      // scrolls down to the end and keeps going counts only the extra travel.
      if (anchorY === null) anchorY = y;
      distance = Math.max(0, anchorY - y);
      paint(distance);
    };
    const onEnd = () => {
      if (!active) return;
      active = false;
      const go = distance >= PULL_THRESHOLD;
      reset();
      if (go) navigateTo(nextChapter);
    };

    target.addEventListener("touchstart", onStart, { passive: true });
    target.addEventListener("touchmove", onMove, { passive: true });
    target.addEventListener("touchend", onEnd);
    target.addEventListener("touchcancel", onEnd);
    return () => {
      target.removeEventListener("touchstart", onStart);
      target.removeEventListener("touchmove", onMove);
      target.removeEventListener("touchend", onEnd);
      target.removeEventListener("touchcancel", onEnd);
      reset();
    };
  }, [hasChapterText, nextChapter, navigateTo]);

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
    scrollToY(scrollerRef.current, 0);
  }, [chapterId]);

  // Restore saved scroll position after text loads. This is deliberately an
  // instant jump: animating through the already-read part is disorienting and
  // fires intermediate scroll events that can save an older position.
  useEffect(() => {
    if (restoredRef.current || !chapterText) return;
    restoredRef.current = true;
    const savedValue = Math.min(
      100,
      Math.max(0, savedProgress?.progress_value ?? 0),
    );
    if (savedValue <= 0) return;
    setScrollPct(Math.round(savedValue));
    // Wait for the themed text and its final font metrics to render.
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      const { max } = scrollMetrics(el);
      scrollToY(el, (savedValue / 100) * Math.max(0, max));
    });
  }, [savedProgress, chapterText]);

  // Track scroll progress at most once per animation frame. Integer-only UI
  // updates keep a long chapter from re-rendering on every scroll event.
  useEffect(() => {
    if (!chapterId || !chapterText) return;
    let frame: number | null = null;
    let lastReported = -1;
    const el = scrollerRef.current;
    const updateScrollProgress = () => {
      frame = null;
      const { top, max } = scrollMetrics(el);
      if (max <= 0) return;
      const pct = Math.min(100, Math.max(0, Math.round((top / max) * 100)));
      setScrollPct((current) => (current === pct ? current : pct));
      if (lastReported !== pct) {
        lastReported = pct;
        reportProgress(pct, 100);
      }
    };
    const handleScroll = () => {
      if (frame === null) frame = requestAnimationFrame(updateScrollProgress);
    };
    const stop = listenScroll(el, handleScroll);
    return () => {
      stop();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [chapterId, chapterText, reportProgress]);

  const updatePreferences = useCallback(
    (
      updater: (current: ReaderPreferences) => ReaderPreferences,
      preservePosition = false,
    ) => {
      const el = scrollerRef.current;
      const { top: oldTop, max: oldScrollMax } = scrollMetrics(el);
      const readingPosition = oldScrollMax > 0 ? oldTop / oldScrollMax : 0;

      setPreferences((current) => {
        const next = updater(current);
        saveReaderPreferences(next);
        return next;
      });

      if (preservePosition && oldScrollMax > 0) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const { max } = scrollMetrics(el);
            scrollToY(el, Math.max(0, max) * readingPosition);
          });
        });
      }
    },
    [],
  );

  function handleFontSize(size: number) {
    updatePreferences((current) => ({ ...current, fontSize: size }), true);
  }

  function handleFontFamily(ff: string) {
    updatePreferences((current) => ({ ...current, fontFamily: ff }), true);
  }

  function handleTheme(t: ReaderTheme) {
    updatePreferences((current) => ({
        ...current,
        theme: t,
        customText: t.text,
        customBg: t.bg,
    }));
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
    updatePreferences((current) => ({
        ...current,
        customText: candidateText,
        customBg: candidateBg,
        // Keep the currently readable palette active until the candidate
        // reaches WCAG AA contrast.
        theme:
          contrastRatio(candidateText, candidateBg) >= 4.5
            ? updated
            : current.theme,
    }));
  }

  function updateReaderLayout(
    field: "lineHeight" | "contentWidth",
    value: number,
  ) {
    updatePreferences((current) => ({ ...current, [field]: value }), true);
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
      <div className="mx-auto flex max-w-md flex-col items-center py-24 text-center text-text-mute">
        <h1 className="text-balance font-display text-xl font-semibold text-text">
          Không thể mở trình đọc
        </h1>
        <p className="mt-2 text-pretty text-sm">
          Vui lòng kiểm tra kết nối rồi thử lại. Nội dung đã tải vẫn có thể đọc
          khi ngoại tuyến.
        </p>
        <div className="mt-5 flex gap-3">
          <ActionButton
            variant="secondary"
            onClick={() => void Promise.all([refetchBook(), refetchChapters()])}
          >
            Thử lại
          </ActionButton>
          <Link
            href={`/book?id=${bookId}`}
            className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold text-accent transition-[background-color,transform] hover:bg-accent/10 active:scale-[0.96] motion-reduce:transition-none"
          >
            Quay lại
          </Link>
        </div>
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
      onClick={handleReaderTap}
      // One continuous surface — escape AppMain's horizontal padding so the
      // theme bg goes edge-to-edge on Android. The whole reader (top bar,
      // hero, content, handoff) sits on this single background.
      //
      // Android: a full-height column — scroller, then the chapter bar — so the
      // scrollbar spans only the text area. Deliberately NOT position:fixed: a
      // fixed root is its own stacking context, which would trap the settings
      // and chapter sheets (z-70) underneath the mini player (z-50).
      className={
        nativeScroll
          ? "-mx-4 sm:-mx-6 -my-2 flex flex-col transition-colors duration-300"
          : "-mx-4 sm:-mx-6 -my-2 px-3 sm:px-6 min-h-[calc(100dvh-3.5rem)] transition-colors duration-300"
      }
      style={{
        backgroundColor: effectiveTheme.bg,
        color: effectiveTheme.text,
        // Android: body already pads for the status and navigation bars, so
        // fill exactly the space between them. A plain 100dvh plus the reader's
        // own --sat pushed the column's bottom — the chapter bar — under the
        // Android navigation buttons.
        height: nativeScroll ? "calc(100dvh - var(--sat) - var(--sab))" : undefined,
        paddingTop: nativeScroll ? undefined : "calc(var(--sat) + 0.5rem)",
        // Web: clears the fixed nav bar so the last lines are never hidden
        // behind it. Android: the bar is in the column, nothing to clear.
        paddingBottom: nativeScroll ? undefined : "calc(5rem + var(--sab))",
        overscrollBehaviorY: "contain",
        // Android: a copy of the column shifted down by the inset paints the
        // strip behind the system navigation buttons in the reader theme —
        // whether or not the chapter bar is showing — instead of the app's
        // dark body showing through on light themes.
        boxShadow: nativeScroll ? `0 var(--sab) 0 0 ${effectiveTheme.bg}` : undefined,
      }}
    >
      <div
        ref={nativeScroll ? scrollerRef : undefined}
        className={nativeScroll ? "min-h-0 flex-1 overflow-y-auto px-3 pt-2 sm:px-6" : undefined}
        style={
          nativeScroll
            ? {
                overscrollBehaviorY: "contain",
                // The global thumb is tuned for the dark app shell and all but
                // disappears on light reader themes; follow the text colour.
                scrollbarColor: "color-mix(in srgb, currentColor 35%, transparent) transparent",
              }
            : undefined
        }
      >
      {/* max-w-6xl, not 3xl: at 768px the whole reader was a phone-width
          column on desktop. The text itself is capped by contentWidth below. */}
      <div className="mx-auto max-w-6xl">
      {/* Reading progress bar (sits below the system status bar). Above the
          top bar, and still there when the bars are hidden. */}
      <div
        className="sticky top-0 z-30 h-0.5 bg-transparent"
        role="progressbar"
        aria-label={`Tiến độ đọc: ${Math.round(scrollPct)} phần trăm`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(scrollPct)}
      >
        <div
          className="h-full bg-accent"
          style={{ width: `${scrollPct}%` }}
        />
      </div>

      {/* Top bar — back / "HỒI N · X%" / settings menu. Pinned while shown,
          so a tap anywhere in the chapter can bring it back; slides away when
          the reader taps the text for immersive reading. */}
      <div
        data-reader-chrome
        inert={chromeHidden}
        // Tailwind v4 slides with the `translate` property, not `transform`,
        // so that is what has to be in the transition list to animate.
        className={`sticky top-0 z-20 -mx-3 mb-4 px-3 transition-[translate,opacity] duration-200 motion-reduce:transition-none sm:-mx-6 sm:px-6 ${
          chromeHidden ? "pointer-events-none -translate-y-full opacity-0" : ""
        }`}
        style={{
          backgroundColor: effectiveTheme.bg,
          boxShadow: "0 1px 0 0 rgba(128,128,128,0.2)",
        }}
      >
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <Link
          href={`/book?id=${bookId}`}
          className="-ml-2 inline-flex size-11 items-center justify-center rounded-full transition-[color,background-color,transform] hover:bg-current/5 hover:text-accent active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:active:scale-100"
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
        <div className="flex items-center">
          {/* Switch to the player. Headphones, not the old microphone — this is
              listening, not recording. Replaces the "Chuyển sang nghe?" card that
              sat at the end of every chapter. Mirrors the book icon on the
              player page, which switches back. */}
          <Link
            href={`/listen?id=${bookId}&chapter=${chapterId}`}
            className="inline-flex size-11 items-center justify-center rounded-full transition-[color,background-color,transform] hover:bg-current/5 hover:text-accent active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:active:scale-100"
            style={{ color: effectiveTheme.text }}
            title="Chuyển sang nghe"
            aria-label="Chuyển sang nghe"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"
              />
            </svg>
          </Link>
          <IconButton
            onClick={() => setShowSettings(!showSettings)}
            label="Cài đặt đọc"
            className={`-mr-2 ${showSettings ? "text-accent" : "hover:text-accent"}`}
            style={{ color: showSettings ? undefined : effectiveTheme.text }}
          >
            {/* Gear, not three lines: this opens display settings, and the
                hamburger read as a navigation menu. Same gear as the home page. */}
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </IconButton>
        </div>
      </div>
      </div>

      <Sheet
        open={showSettings}
        onClose={() => setShowSettings(false)}
        title="Cài đặt đọc"
        description="Chữ, màu và chiều rộng nội dung"
      >
        <div className="space-y-5">
          <div
            className="rounded-2xl p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_8px_24px_-16px_rgba(0,0,0,0.7)]"
            style={{ backgroundColor: effectiveTheme.bg, color: effectiveTheme.text }}
          >
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] opacity-60">
              Xem trước
            </p>
            <p style={{ fontFamily, fontSize, lineHeight }} lang="vi">
              Mỗi trang sách nên êm mắt, rõ chữ và giữ đúng vị trí bạn đang đọc.
            </p>
          </div>

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
                  aria-label={`Cỡ chữ ${size} pixel`}
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
              Giãn dòng <span className="font-mono text-xs tabular-nums text-text-faint">{lineHeight.toFixed(1)}</span>
              <input
                aria-label="Giãn dòng"
                type="range"
                min="1.4"
                max="2.2"
                step="0.1"
                value={lineHeight}
                onChange={(event) => updateReaderLayout("lineHeight", Number(event.target.value))}
                className="mt-2 h-11 w-full accent-[var(--color-accent)]"
              />
            </label>
            <label className="block text-sm font-semibold text-text-dim">
              Độ dài dòng <span className="font-mono text-xs tabular-nums text-text-faint">{contentWidth} ký tự</span>
              <input
                aria-label="Độ dài dòng"
                type="range"
                min={CONTENT_WIDTH.min}
                max={CONTENT_WIDTH.max}
                step={CONTENT_WIDTH.step}
                value={contentWidth}
                onChange={(event) => updateReaderLayout("contentWidth", Number(event.target.value))}
                className="mt-2 h-11 w-full accent-[var(--color-accent)]"
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
              <div className="mt-3 flex items-center gap-3 rounded-xl border border-gold/30 bg-gold/10 p-3 text-xs text-gold" role="status" aria-live="polite">
                <span className="flex-1">Độ tương phản chưa đủ 4.5:1 nên màu này chưa được áp dụng.</span>
                <button
                  type="button"
                  onClick={() => {
                    updatePreferences(() => DEFAULT_READER_PREFERENCES, true);
                  }}
                  className="min-h-11 rounded-lg px-2 font-semibold underline underline-offset-2"
                >
                  Đặt lại
                </button>
              </div>
            )}
          </fieldset>

          <ActionButton
            variant="secondary"
            onClick={() => updatePreferences(() => DEFAULT_READER_PREFERENCES, true)}
            className="w-full"
          >
            Khôi phục cài đặt mặc định
          </ActionButton>
        </div>
      </Sheet>

      {/* Chapter title — deliberately plain. The eyebrow, ❖ ornament and word
          count that used to sit here were decoration competing with the text,
          and the chapter number already shows in the top bar. Colour comes from
          the reader theme rather than the app palette so it doesn't clash on
          sepia / neon / warm. */}
      {/* Same width as the text column so the title lines up with the first
          paragraph instead of hanging off to the left of it. */}
      <h1
        id="reader-chapter-title"
        className="mx-auto mb-6 w-full text-balance text-lg font-semibold leading-snug sm:text-xl"
        style={{ color: effectiveTheme.text, maxWidth: `${contentWidth}ch` }}
      >
        {currentChapter.title}
      </h1>

      <div ref={pullTargetRef} className="mx-auto" style={{ maxWidth: `${contentWidth}ch` }}>
      {/* Reading content — no card; inherits the page's theme bg so the
          whole reader reads as one continuous surface. */}
      <div
        ref={contentRef}
        className="min-h-[50vh] py-2"
      >
        {isLoadingText ? (
          <div
            className="space-y-4 py-4 animate-pulse motion-reduce:animate-none"
            style={{ color: effectiveTheme.text }}
            role="status"
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
        ) : chapterTextError ? (
          <div
            className="mx-auto flex max-w-sm flex-col items-center py-16 text-center"
            style={{ color: effectiveTheme.text }}
            role="alert"
          >
            <svg
              className="size-10 opacity-50"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v4m0 4h.01M10.3 3.7 2.6 17A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
            </svg>
            <h2 className="mt-3 text-balance text-lg font-semibold">
              Chưa tải được nội dung chương
            </h2>
            <p className="mt-1 text-pretty text-sm opacity-65">
              Kiểm tra kết nối hoặc thử lại nếu chương này chưa được tải xuống.
            </p>
            <button
              type="button"
              onClick={() => void refetchChapterText()}
              disabled={isFetchingText}
              className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-accent px-5 text-sm font-semibold text-ink transition-[background-color,opacity,transform] hover:bg-accent-dim active:scale-[0.96] disabled:opacity-50 motion-reduce:transition-none"
            >
              {isFetchingText ? "Đang thử lại…" : "Thử lại"}
            </button>
          </div>
        ) : text ? (
          <ReaderArticle
            text={text}
            fontSize={fontSize}
            fontFamily={fontFamily}
            lineHeight={lineHeight}
            textColor={effectiveTheme.text}
          />
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

      {/* End-of-chapter navigation — in the text, not the chapter bar, so it
          is still there when the bars are hidden for immersive reading. The
          accessible names differ from the chapter bar's on purpose: the same
          name twice on one page is ambiguous to a screen reader. */}
      {hasChapterText && (
        <nav aria-label="Điều hướng cuối chương" className="mt-10 pb-4">
          <div className="flex items-center gap-3" style={{ opacity: 0.55 }}>
            <span className="h-px flex-1 bg-current/30" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
              Hết chương {currentChapter.chapter_index + 1}
            </span>
            <span className="h-px flex-1 bg-current/30" />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => navigateTo(prevChapter)}
              disabled={!prevChapter}
              aria-label={
                prevChapter
                  ? `Sang chương trước, chương ${prevChapter.chapter_index + 1}`
                  : "Đây là chương đầu tiên"
              }
              className="flex min-h-14 touch-manipulation flex-col items-start justify-center rounded-xl bg-current/5 px-4 text-left transition-[transform,background-color] duration-150 hover:bg-current/10 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              <span className="text-[11px] leading-none" style={{ opacity: 0.6 }}>
                ‹ Chương trước
              </span>
              <span className="mt-1 text-sm font-semibold tabular-nums">
                {prevChapter ? `Chương ${prevChapter.chapter_index + 1}` : "—"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => navigateTo(nextChapter)}
              disabled={!nextChapter}
              aria-label={
                nextChapter
                  ? `Sang chương sau, chương ${nextChapter.chapter_index + 1}`
                  : "Đây là chương mới nhất"
              }
              className="flex min-h-14 touch-manipulation flex-col items-end justify-center rounded-xl bg-accent/15 px-4 text-right text-accent ring-1 ring-accent/30 transition-[transform,background-color] duration-150 hover:bg-accent/25 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              <span className="text-[11px] leading-none opacity-80">Chương sau ›</span>
              <span className="mt-1 text-sm font-semibold tabular-nums">
                {nextChapter ? `Chương ${nextChapter.chapter_index + 1}` : "—"}
              </span>
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowToc(true)}
            className="mx-auto mt-2 flex min-h-11 touch-manipulation items-center justify-center rounded-lg px-4 text-xs font-medium transition-[transform,background-color] hover:bg-current/5 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:active:scale-100"
            style={{ opacity: 0.7 }}
          >
            Mục lục
          </button>
          {/* Pull-up hint. Touch screens only — there is nothing to pull with
              a mouse. The bar fills as the finger travels past the end. */}
          {nextChapter && (
            <div
              className="mt-4 hidden flex-col items-center gap-2 pointer-coarse:flex"
              aria-hidden="true"
            >
              <div className="h-1 w-24 overflow-hidden rounded-full bg-current/10">
                <div ref={pullFillRef} className="h-full w-0 bg-accent" />
              </div>
              <p className="text-xs" style={{ opacity: 0.6 }}>
                {pullArmed ? "Thả tay để sang chương sau" : "Kéo lên để sang chương sau"}
              </p>
            </div>
          )}
        </nav>
      )}

      {!nativeScroll && !chromeHidden && <ReaderPlayerClearance />}
      </div>
      </div>
      {/* End of the scroller. Everything below — chapter bar, sheets — must
          sit OUTSIDE it: on Android the chapter bar is a plain column item, and
          inside the scroller it scrolled away with the text. */}
      </div>

      {/* Android: the mini player is pinned just above the chapter bar. This
          spacer sits under it, so the scroller — and its scrollbar — stop at
          the mini player instead of running beneath it. */}
      {nativeScroll && !chromeHidden && <ReaderPlayerClearance />}

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
        data-reader-chrome
        inert={chromeHidden}
        className={
          nativeScroll
            ? // Android: out of the column while hidden, so the text box
              // grows into the space instead of leaving a blank strip.
              `relative z-30 shrink-0 px-3 ${chromeHidden ? "hidden" : ""}`
            : `fixed bottom-0 left-0 right-0 z-30 px-3 transition-transform duration-200 motion-reduce:transition-none ${
                chromeHidden ? "pointer-events-none translate-y-full" : ""
              }`
        }
        style={{
          paddingTop: "0.75rem",
          // Web: the bar is fixed to the screen edge, so it pads for the inset
          // itself. Android: it ends where body's inset padding begins.
          paddingBottom: nativeScroll ? "0.75rem" : "calc(0.75rem + var(--sab))",
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
            className="flex min-h-11 shrink-0 touch-manipulation items-center gap-1.5 rounded-xl bg-current/5 px-3.5 transition-[transform,background-color] duration-150 hover:bg-current/10 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:active:scale-100"
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
            className="flex min-h-11 min-w-0 flex-1 touch-manipulation flex-col items-center justify-center rounded-xl border border-current/15 px-3 transition-[transform,background-color] duration-150 hover:bg-current/5 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:active:scale-100"
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
            className="flex min-h-11 shrink-0 touch-manipulation items-center gap-1.5 rounded-xl bg-current/5 px-3.5 transition-[transform,background-color] duration-150 hover:bg-current/10 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:active:scale-100"
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
            <div className="relative pb-2">
              <input
                type="text"
                inputMode="search"
                enterKeyHint="search"
                autoFocus={!isNativePlatform()}
                value={tocSearch}
                onChange={(e) => setTocSearch(e.target.value)}
                placeholder="Tìm chương theo số hoặc tiêu đề..."
                className="min-h-11 w-full rounded-lg border border-hairline bg-ink py-2 pl-3 pr-12 text-base text-text-dim outline-none focus:border-accent focus:ring-2 focus:ring-accent"
              />
              {tocSearch && (
                <button
                  type="button"
                  onClick={() => setTocSearch("")}
                  className="absolute right-0 top-0 inline-flex size-11 items-center justify-center rounded-lg text-text-mute transition-[color,background-color,transform] hover:bg-raised hover:text-text active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none"
                  aria-label="Xóa tìm kiếm"
                >
                  <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path strokeLinecap="round" d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              )}
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
                        className={`absolute left-0 top-0 flex min-h-11 w-full touch-manipulation select-none items-center gap-3 rounded-lg px-3 text-left transition-[color,background-color,transform] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none ${
                          isCurrent
                            ? "bg-accent/15 dark:bg-accent/40 text-accent-dim dark:text-accent"
                            : "text-text-dim dark:text-text-faint hover:bg-ink dark:hover:bg-raised"
                        }`}
                      >
                        <span
                          className={`shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-semibold ${
                            isCurrent
                              ? "bg-accent text-ink"
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
  );
}
