"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "@/lib/api";
import { getCachedAllChapters } from "@/lib/bookCache";
import { AsyncState } from "@/components/ui/AsyncState";
import { Sheet } from "@/components/ui/Sheet";
import type { Chapter } from "@/types";

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("vi");
}

export function ChapterPickerSheet({
  bookId,
  open,
  onClose,
}: {
  bookId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["chapter-picker", bookId],
    enabled: open,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      try {
        const first = await api.getBookChapters(bookId, 1, 1000);
        const chapters: Chapter[] = [...first.items];
        for (let page = 2; page <= first.total_pages; page++) {
          chapters.push(...(await api.getBookChapters(bookId, page, 1000)).items);
        }
        return chapters;
      } catch {
        const cached = await getCachedAllChapters(bookId);
        if (cached) return cached.items;
        throw new Error("chapters-unavailable");
      }
    },
  });

  const filtered = useMemo(() => {
    const query = normalize(search.trim());
    if (!query) return data ?? [];
    return (data ?? []).filter(
      (chapter) =>
        normalize(chapter.title).includes(query) ||
        String(chapter.chapter_index + 1).includes(query),
    );
  }, [data, search]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Chọn chương"
      description={data ? `${data.length} chương` : undefined}
    >
      <label className="block">
        <span className="sr-only">Tìm theo tên hoặc số chương</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Tìm theo tên hoặc số chương"
          className="min-h-11 w-full rounded-xl border border-hairline bg-raised px-4 text-sm text-text outline-none transition-[border-color,box-shadow] placeholder:text-text-faint focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </label>

      {isLoading && <AsyncState compact kind="loading" title="Đang tải chương" />}
      {error && (
        <AsyncState
          compact
          kind="error"
          title="Không thể tải danh sách chương"
          onAction={() => void refetch()}
        />
      )}
      {!isLoading && !error && filtered.length === 0 && (
        <AsyncState compact kind="empty" title="Không tìm thấy chương" />
      )}

      {filtered.length > 0 && (
        <div
          ref={scrollRef}
          className="mt-3 h-[min(56dvh,32rem)] overflow-y-auto overscroll-contain rounded-xl border border-hairline-soft bg-ink/30"
        >
          <div
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const chapter = filtered[item.index];
              return (
                <div
                  key={chapter.id}
                  className="absolute left-0 top-0 flex w-full items-center gap-2 border-b border-hairline-soft px-3"
                  style={{
                    height: `${item.size}px`,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-text-faint">
                    {chapter.chapter_index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-dim">
                    {chapter.title}
                  </span>
                  <Link
                    href={`/read?id=${bookId}&chapter=${chapter.id}`}
                    onClick={onClose}
                    className="inline-flex size-11 items-center justify-center rounded-lg text-xs font-semibold text-text-mute transition-[color,background-color,transform] hover:bg-raised hover:text-accent active:scale-[0.96]"
                    aria-label={`Đọc ${chapter.title}`}
                  >
                    Đọc
                  </Link>
                  <Link
                    href={`/listen?id=${bookId}&chapter=${chapter.id}`}
                    onClick={onClose}
                    className="inline-flex size-11 items-center justify-center rounded-lg bg-accent/10 text-xs font-semibold text-accent transition-[background-color,transform] hover:bg-accent/20 active:scale-[0.96]"
                    aria-label={`Nghe ${chapter.title}`}
                  >
                    Nghe
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Sheet>
  );
}

