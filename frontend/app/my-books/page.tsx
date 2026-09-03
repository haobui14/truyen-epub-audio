"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isLoggedIn } from "@/lib/auth";
import { getCachedMyBooks, setCachedMyBooks } from "@/lib/progressQueue";
import { AsyncState } from "@/components/ui/AsyncState";
import { ConnectivityStatus } from "@/components/ui/ConnectivityStatus";
import type { MyBookProgressEntry } from "@/types";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return `${Math.floor(days / 30)} tháng trước`;
}

function ProgressBar({ value, total }: { value: number; total?: number }) {
  const pct = total && total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="h-1 w-full bg-raised dark:bg-raised-hi rounded-full overflow-hidden">
      <div
        className="h-full bg-accent rounded-full transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function BookRow({ entry }: { entry: MyBookProgressEntry }) {
  const { book, chapter, progress_value, total_value, updated_at } = entry;
  const href = `/listen?id=${book.id}&chapter=${chapter.id}`;
  const readHref = `/read?id=${book.id}&chapter=${chapter.id}`;
  const pct =
    total_value && total_value > 0
      ? Math.round((progress_value / total_value) * 100)
      : null;

  return (
    <div className="group relative flex gap-3 rounded-xl border border-hairline-soft bg-surface p-3 transition-[border-color,box-shadow] hover:border-accent/40 hover:shadow-md">
      <Link href={href} className="flex gap-3 flex-1 min-w-0">
      {/* Cover */}
      <div className="image-outline relative h-[4.67rem] w-14 shrink-0 overflow-hidden rounded-lg bg-linear-to-br from-raised to-raised-hi">
        {book.cover_url ? (
          <Image
            src={book.cover_url}
            alt={book.title}
            fill
            sizes="56px"
            className="object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg
              className="w-6 h-6 text-accent dark:text-accent-dim"
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

      {/* Info */}
      <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
        <div>
          <h3 className="font-semibold text-sm text-text dark:text-text line-clamp-1 group-hover:text-accent dark:group-hover:text-accent transition-colors">
            {book.title}
          </h3>
          {book.author && (
            <p className="text-xs text-text-mute dark:text-text-mute truncate mt-0.5">
              {book.author}
            </p>
          )}
        </div>

        <div className="mt-1.5 space-y-1.5">
          <div className="flex items-center">
            <span className="text-xs text-text-mute dark:text-text-mute truncate">
              {chapter.title}
            </span>
          </div>

          <ProgressBar value={progress_value} total={total_value} />

          <div className="flex items-center justify-between text-[10px] text-text-mute dark:text-text-mute">
            <span>{book.total_chapters} chương</span>
            <div className="flex items-center gap-2">
              {pct !== null && <span>{pct}%</span>}
              <span>{timeAgo(updated_at)}</span>
            </div>
          </div>
        </div>
      </div>

      </Link>

      {/* Quick actions: read or listen from where you left off */}
      <div className="flex flex-col items-center justify-center gap-1.5 shrink-0">
        <Link
          href={readHref}
          aria-label="Đọc tiếp"
          title="Đọc tiếp"
          className="flex size-11 items-center justify-center rounded-lg text-text-mute transition-[color,background-color,transform] hover:bg-accent/10 hover:text-accent active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <svg
            className="w-[18px] h-[18px]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.8}
              d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
            />
          </svg>
        </Link>
        <Link
          href={href}
          aria-label="Nghe tiếp"
          title="Nghe tiếp"
          className="flex size-11 items-center justify-center rounded-lg text-text-mute transition-[color,background-color,transform] hover:bg-accent/10 hover:text-accent active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <svg
            className="w-[18px] h-[18px]"
            fill="currentColor"
            viewBox="0 0 14 14"
          >
            <path d="M3 1l10 6-10 6V1z" />
          </svg>
        </Link>
      </div>
    </div>
  );
}

export default function MyBooksPage() {
  const [loggedIn, setLoggedIn] = useState(() => isLoggedIn());

  useEffect(() => {
    const h = () => setLoggedIn(isLoggedIn());
    window.addEventListener("auth-change", h);
    return () => window.removeEventListener("auth-change", h);
  }, []);

  const { data, isLoading, error, refetch } = useQuery({
    // This query returns { entries, cached }, unlike the shared ["my-books"]
    // query on Home/Profile, which returns an array. A distinct key prevents
    // React Query from handing either screen the other screen's data shape.
    queryKey: ["my-books", "offline-aware-page"],
    queryFn: async () => {
      try {
        const result = await api.getMyBooks();
        await setCachedMyBooks(result);
        return { entries: result, cached: false };
      } catch {
        const cached = await getCachedMyBooks();
        if (cached) {
          return { entries: cached, cached: true };
        }
        throw new Error("Không có dữ liệu đã lưu");
      }
    },
    enabled: loggedIn,
    staleTime: 30_000,
  });

  if (!loggedIn) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <svg
          className="w-14 h-14 text-text-faint dark:text-text-dim mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
          />
        </svg>
        <p className="text-text-mute dark:text-text-mute mb-4">
          Đăng nhập để xem lịch sử đọc/nghe
        </p>
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-ink transition-[background-color,transform] hover:bg-accent-dim active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          Đăng nhập
        </Link>
      </div>
    );
  }

  const entries = Array.isArray(data?.entries) ? data.entries : [];

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <ConnectivityStatus cached={data?.cached ?? false} />
      <div className="mt-5 flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-text dark:text-text">
            Truyện của tôi
          </h1>
          <p className="text-sm text-text-mute dark:text-text-mute mt-0.5">
            Tiếp tục đọc hoặc nghe từ nơi bạn dừng lại
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/my-books/downloads"
            className="inline-flex min-h-11 items-center rounded-xl border border-hairline px-3 text-xs font-semibold text-text-mute transition-[color,border-color,transform] hover:border-accent/40 hover:text-accent active:scale-[0.96]"
          >
            Tải xuống
          </Link>
          {entries.length > 0 && (
            <span className="rounded-full bg-raised px-3 py-1.5 text-xs font-medium text-text-mute">
              {entries.length} truyện
            </span>
          )}
        </div>
      </div>

      {isLoading && entries.length === 0 && (
        <AsyncState kind="loading" title="Đang tải truyện của bạn" />
      )}

      {error && entries.length === 0 && (
        <AsyncState
          kind="error"
          title="Không thể tải danh sách"
          message="Chưa có bản đã lưu trên thiết bị này."
          onAction={() => void refetch()}
        />
      )}

      {!isLoading && entries.length === 0 && !error && (
        <AsyncState
          kind="empty"
          title="Chưa có truyện đang đọc"
          message="Truyện bạn đọc hoặc nghe sẽ xuất hiện tại đây."
        />
      )}

      <div className="space-y-2.5">
        {entries.map((entry) => (
          <BookRow key={entry.book.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
