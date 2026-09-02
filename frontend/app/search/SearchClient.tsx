"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cacheBooks, getCachedBooks } from "@/lib/bookCache";
import { isNativePlatform } from "@/lib/capacitor";
import { BookListRow } from "@/components/books/BookListRow";
import { AsyncState } from "@/components/ui/AsyncState";
import { ConnectivityStatus } from "@/components/ui/ConnectivityStatus";
import type { Genre } from "@/types";

type StoryFilter = "all" | "completed" | "ongoing";

const STORY_FILTER_OPTIONS: { value: StoryFilter; label: string }[] = [
  { value: "all", label: "Tất cả" },
  { value: "completed", label: "Hoàn thành" },
  { value: "ongoing", label: "Đang ra" },
];

export default function SearchClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [usingCachedBooks, setUsingCachedBooks] = useState(false);

  // Initialise from URL params so the page is bookmarkable / shareable
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [storyFilter, setStoryFilter] = useState<StoryFilter>(
    (searchParams.get("status") as StoryFilter) ?? "all",
  );
  const [genreFilter, setGenreFilter] = useState<string | null>(
    searchParams.get("genre") ?? null,
  );

  // Sync URL ↔ state (push on filter change so Back button works naturally)
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (storyFilter !== "all") params.set("status", storyFilter);
    if (genreFilter) params.set("genre", genreFilter);
    const newUrl = params.toString() ? `/search?${params}` : "/search";
    router.replace(newUrl, { scroll: false });
  }, [query, storyFilter, genreFilter, router]);

  // Auto-focus the search bar on mount — but NOT on native Android, where it
  // pops the soft keyboard the instant the page opens, hiding the filter chips
  // and results and making the page feel broken.
  useEffect(() => {
    if (!isNativePlatform()) inputRef.current?.focus();
  }, []);

  const {
    data: books,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["books"],
    queryFn: async () => {
      try {
        const result = await api.listBooks();
        setUsingCachedBooks(false);
        await cacheBooks(result);
        return result;
      } catch {
        const cached = await getCachedBooks();
        if (cached) {
          setUsingCachedBooks(true);
          return cached;
        }
        throw new Error("offline");
      }
    },
    staleTime: 5 * 60_000,
  });

  const { data: genres } = useQuery({
    queryKey: ["genres"],
    queryFn: api.listGenres,
    staleTime: 30 * 60_000,
  });

  // Only show genres that are actually used by at least one book
  const usedGenres = useMemo<Genre[]>(() => {
    if (!books || !genres) return [];
    const usedIds = new Set(
      books.flatMap((b) => (b.genres ?? []).map((g) => g.id)),
    );
    return genres.filter((g) => usedIds.has(g.id));
  }, [books, genres]);

  const results = useMemo(() => {
    if (!books) return [];
    const q = query.trim().toLowerCase();

    return books.filter((b) => {
      // Text match: title or author
      const textMatch =
        !q ||
        b.title.toLowerCase().includes(q) ||
        (b.author ?? "").toLowerCase().includes(q);

      // Story status filter
      const statusMatch =
        storyFilter === "all" || (b.story_status ?? "unknown") === storyFilter;

      // Genre filter
      const genreMatch =
        !genreFilter || (b.genres ?? []).some((g) => g.id === genreFilter);

      return textMatch && statusMatch && genreMatch;
    });
  }, [books, query, storyFilter, genreFilter]);

  const hasActiveFilters = query || storyFilter !== "all" || genreFilter;

  function clearAll() {
    setQuery("");
    setStoryFilter("all");
    setGenreFilter(null);
    inputRef.current?.focus();
  }

  return (
    <div className="max-w-2xl mx-auto">
      <ConnectivityStatus cached={usingCachedBooks} />
      {/* Page title */}
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-text dark:text-text leading-tight">
          Tìm kiếm
        </h1>
        <p className="text-sm text-text-mute dark:text-text-mute mt-0.5">
          Tìm truyện theo tên, tác giả hoặc thể loại
        </p>
      </div>

      {/* Search bar */}
      <div className="relative mb-4">
        <svg
          className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-text-mute dark:text-text-mute pointer-events-none"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          ref={inputRef}
          type="search"
          placeholder="Tên truyện hoặc tác giả…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-h-11 w-full rounded-2xl border border-hairline bg-surface py-3 pl-10 pr-12 text-sm text-text shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-text-faint focus:border-accent focus:ring-2 focus:ring-accent/40"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            aria-label="Xóa từ khóa"
            className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full text-text-mute transition-[color,transform] hover:text-text active:scale-[0.96]"
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
        )}
      </div>

      {/* Filters */}
      <div className="space-y-3 mb-5">
        {/* Story status */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-mute dark:text-text-mute mb-2">
            Tình trạng
          </p>
          <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none -mx-4 sm:mx-0 px-4 sm:px-0">
            {STORY_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setStoryFilter(opt.value)}
                className={`min-h-11 flex-none whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium transition-[color,background-color,transform] active:scale-[0.96] ${
                  storyFilter === opt.value
                    ? "bg-accent text-white shadow-sm"
                    : "bg-raised dark:bg-raised text-text-dim dark:text-text-mute hover:bg-raised-hi dark:hover:bg-raised-hi"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Genre chips */}
        {usedGenres.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-mute dark:text-text-mute mb-2">
              Thể loại
            </p>
            <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none -mx-4 sm:mx-0 px-4 sm:px-0">
              <button
                onClick={() => setGenreFilter(null)}
                className={`min-h-11 flex-none whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium transition-[color,background-color,transform] active:scale-[0.96] ${
                  genreFilter === null
                    ? "bg-accent text-white shadow-sm"
                    : "bg-raised dark:bg-raised text-text-dim dark:text-text-mute hover:bg-raised-hi dark:hover:bg-raised-hi"
                }`}
              >
                Tất cả
              </button>
              {usedGenres.map((g) => (
                <button
                  key={g.id}
                  onClick={() =>
                    setGenreFilter(genreFilter === g.id ? null : g.id)
                  }
                  className={`min-h-11 flex-none whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium transition-[color,background-color,transform] active:scale-[0.96] ${
                    genreFilter === g.id
                      ? "bg-accent text-white shadow-sm"
                      : "bg-raised dark:bg-raised text-text-dim dark:text-text-mute hover:bg-raised-hi dark:hover:bg-raised-hi"
                  }`}
                >
                  {g.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Results header */}
      {!isLoading && books && (
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-text-mute dark:text-text-mute">
            {hasActiveFilters
              ? `${results.length} kết quả`
              : `${books.length} truyện`}
          </p>
          {hasActiveFilters && (
            <button
              onClick={clearAll}
              className="min-h-11 rounded-lg px-2 text-xs text-accent hover:underline"
            >
              Xóa bộ lọc
            </button>
          )}
        </div>
      )}

      {/* States */}
      {isLoading && (
        <AsyncState kind="loading" title="Đang tải thư viện" />
      )}

      {error && (
        <AsyncState
          kind="error"
          title="Không thể tải danh sách truyện"
          message="Chưa có bản đã lưu. Hãy kiểm tra kết nối và thử lại."
          onAction={() => void refetch()}
        />
      )}

      {!isLoading && !error && results.length === 0 && (
        <div className="text-center py-20 text-text-mute dark:text-text-mute">
          <svg
            className="w-12 h-12 mx-auto mb-3 text-text-dim dark:text-text-dim"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <p className="text-base font-medium text-text-mute dark:text-text-mute">
            {hasActiveFilters
              ? "Không tìm thấy kết quả"
              : "Nhập từ khóa để tìm kiếm"}
          </p>
          {hasActiveFilters && (
            <button
              onClick={clearAll}
              className="mt-3 min-h-11 rounded-lg px-3 text-sm text-accent hover:underline"
            >
              Xóa bộ lọc
            </button>
          )}
        </div>
      )}

      {/* Results list — one book per row */}
      {!isLoading && !error && results.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {results.map((book) => (
            <BookListRow key={book.id} book={book} />
          ))}
        </div>
      )}
    </div>
  );
}
