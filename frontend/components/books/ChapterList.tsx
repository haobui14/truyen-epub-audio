"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isAdmin } from "@/lib/auth";
import type { Chapter } from "@/types";

function ChapterRow({
  chapter,
  bookId,
  selected,
  onToggleSelect,
  showAdmin,
  editBasePath,
  activeChapterId,
}: {
  chapter: Chapter;
  bookId: string;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  showAdmin: boolean;
  editBasePath?: string;
  activeChapterId?: string;
}) {
  const isActive =
    (editBasePath && chapter.id === activeChapterId) || selected;
  return (
    <div
      className={`flex items-center gap-3 py-3 px-4 transition-colors ${
        isActive ? "bg-accent/10" : "hover:bg-raised-hi"
      }`}
    >
      {showAdmin && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(chapter.id)}
          className="w-5 h-5 rounded border-hairline bg-raised text-accent focus:ring-accent cursor-pointer shrink-0 accent-[var(--color-accent)]"
        />
      )}
      <span className="font-mono text-[10px] tracking-wider text-text-faint w-8 shrink-0 text-right">
        {chapter.chapter_index + 1}
      </span>
      <div className="flex-1 min-w-0">
        {editBasePath ? (
          <Link href={`${editBasePath}${chapter.id}`} className="group block">
            <p className="text-sm font-medium text-text truncate group-hover:text-accent transition-colors">
              {chapter.title}
            </p>
            <p className="font-mono text-[10px] tracking-wider uppercase text-text-faint mt-0.5">
              {chapter.word_count.toLocaleString()} từ
            </p>
          </Link>
        ) : (
          <>
            <p className="text-sm font-medium text-text truncate">
              {chapter.title}
            </p>
            <p className="font-mono text-[10px] tracking-wider uppercase text-text-faint mt-0.5">
              {chapter.word_count.toLocaleString()} từ
            </p>
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0 touch-manipulation">
        {!editBasePath && (
          <>
            <Link
              href={`/read?id=${bookId}&chapter=${chapter.id}`}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-text-mute hover:text-accent bg-raised-hi hover:bg-accent/15 rounded-md transition-colors"
              title="Đọc"
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
                  d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                />
              </svg>
            </Link>
            <Link
              href={`/listen?id=${bookId}&chapter=${chapter.id}`}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md bg-accent text-ink shadow-[0_0_12px_var(--color-accent-glow)] transition-[background-color,transform] hover:bg-accent-dim active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
              title="Nghe"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 14 14">
                <path d="M3 1l10 6-10 6V1z" />
              </svg>
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

function PaginationButton({
  page,
  currentPage,
  onClick,
}: {
  page: number;
  currentPage: number;
  onClick: (p: number) => void;
}) {
  const isActive = page === currentPage;
  return (
    <button
      onClick={() => onClick(page)}
      className={`min-w-10 h-10 px-2 text-sm font-medium rounded-md transition-colors ${
        isActive
          ? "bg-accent text-ink shadow-[0_0_12px_var(--color-accent-glow)]"
          : "text-text-mute hover:bg-raised-hi"
      }`}
    >
      {page}
    </button>
  );
}

function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  const [inputVal, setInputVal] = useState("");

  if (totalPages <= 1) return null;

  const pages: (number | "ellipsis")[] = [];
  const addPage = (p: number) => {
    if (p >= 1 && p <= totalPages && !pages.includes(p)) {
      pages.push(p);
    }
  };

  addPage(1);
  if (page > 3) pages.push("ellipsis");
  for (
    let i = Math.max(2, page - 1);
    i <= Math.min(totalPages - 1, page + 1);
    i++
  ) {
    addPage(i);
  }
  if (page < totalPages - 2) pages.push("ellipsis");
  addPage(totalPages);

  function handleGo(e: React.FormEvent) {
    e.preventDefault();
    const p = parseInt(inputVal, 10);
    if (p >= 1 && p <= totalPages) {
      onPageChange(p);
      setInputVal("");
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-hairline-soft space-y-2">
      <div className="flex items-center justify-center gap-1">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="h-10 px-3 text-sm font-medium rounded-md text-text-mute hover:bg-raised-hi disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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

        {pages.map((p, i) =>
          p === "ellipsis" ? (
            <span
              key={`ellipsis-${i}`}
              className="px-1 text-text-faint text-sm"
            >
              …
            </span>
          ) : (
            <PaginationButton
              key={p}
              page={p}
              currentPage={page}
              onClick={onPageChange}
            />
          ),
        )}

        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="h-10 px-3 text-sm font-medium rounded-md text-text-mute hover:bg-raised-hi disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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

      <form
        onSubmit={handleGo}
        className="flex items-center justify-center gap-2"
      >
        <span className="font-mono text-[10px] tracking-widest uppercase text-text-faint">
          Đến trang
        </span>
        <input
          type="number"
          min={1}
          max={totalPages}
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          placeholder={String(page)}
          className="w-14 h-8 text-sm text-center border border-hairline rounded-md bg-raised text-text focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
        />
        <span className="font-mono text-[10px] tracking-widest uppercase text-text-faint">
          / {totalPages}
        </span>
        <button
          type="submit"
          className="h-8 px-3 font-mono text-[10px] tracking-widest uppercase text-accent border border-accent/40 rounded-md hover:bg-accent/10 transition-colors"
        >
          Đến
        </button>
      </form>
    </div>
  );
}

export function ChapterList({
  chapters,
  bookId,
  page,
  totalPages,
  total,
  onPageChange,
  editBasePath,
  activeChapterId,
}: {
  chapters: Chapter[];
  bookId: string;
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
  editBasePath?: string;
  activeChapterId?: string;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const admin = isAdmin() && !!editBasePath;
  const currentPageIds = chapters.map((ch) => ch.id);
  const allCurrentSelected =
    currentPageIds.length > 0 && currentPageIds.every((id) => selected.has(id));
  const someCurrentSelected = currentPageIds.some((id) => selected.has(id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        someCurrentSelected && !allCurrentSelected;
    }
  }, [someCurrentSelected, allCurrentSelected]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allCurrentSelected) {
        currentPageIds.forEach((id) => next.delete(id));
      } else {
        currentPageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  function handlePageChange(nextPage: number) {
    setSelected(new Set());
    onPageChange(nextPage);
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (
      !confirm(
        `Xoá ${ids.length} chương đã chọn? Thao tác này không thể hoàn tác.`,
      )
    )
      return;
    setBulkDeleting(true);
    try {
      await api.bulkDeleteChapters(ids);
      ids.forEach((id) =>
        queryClient.removeQueries({ queryKey: ["chapterText", id] }),
      );
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Xoá thất bại");
    } finally {
      setBulkDeleting(false);
    }
  }

  if (chapters.length === 0 && page === 1) {
    return (
      <div className="text-center py-12 text-text-faint text-sm italic">
        Đang phân tích chương...
      </div>
    );
  }

  return (
    <div aria-label={`${total} chương`}>
      {admin && selected.size > 0 && (
        <div className="flex items-center justify-between mb-3 px-4 py-2.5 bg-vermillion/10 border border-vermillion/30 rounded-md">
          <span className="text-sm font-medium text-vermillion">
            Đã chọn {selected.size} chương
          </span>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-ink bg-vermillion hover:bg-vermillion-dim rounded-md transition-colors disabled:opacity-50"
          >
            {bulkDeleting ? (
              <svg
                className="w-4 h-4 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            ) : (
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
            )}
            Xoá {selected.size} chương
          </button>
        </div>
      )}
      <div className="bg-surface rounded-md ring-1 ring-hairline overflow-hidden">
        {admin && (
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-hairline-soft bg-raised">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allCurrentSelected}
              onChange={toggleSelectAll}
              className="w-5 h-5 rounded border-hairline bg-raised text-accent focus:ring-accent cursor-pointer accent-[var(--color-accent)]"
            />
            <span className="font-mono text-[10px] tracking-widest uppercase text-text-mute">
              {allCurrentSelected ? "Bỏ chọn tất cả" : "Chọn tất cả trang này"}
            </span>
          </div>
        )}
        <div className="divide-y divide-hairline-soft">
          {chapters.map((ch) => (
            <ChapterRow
              key={ch.id}
              chapter={ch}
              bookId={bookId}
              selected={selected.has(ch.id)}
              onToggleSelect={toggleSelect}
              showAdmin={admin}
              editBasePath={editBasePath}
              activeChapterId={activeChapterId}
            />
          ))}
        </div>
      </div>
      <Pagination
        page={page}
        totalPages={totalPages}
        onPageChange={handlePageChange}
      />
    </div>
  );
}
