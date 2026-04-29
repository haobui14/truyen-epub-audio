"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isLoggedIn } from "@/lib/auth";
import { Spinner } from "@/components/ui/Spinner";
import { getCachedMyBooks, setCachedMyBooks } from "@/lib/progressQueue";

type MyBookEntry = {
  book: {
    id: string;
    title: string;
    author?: string;
    cover_url?: string;
    total_chapters: number;
  };
  chapter: { id: string; chapter_index: number; title: string };
  progress_value: number;
  total_value?: number;
  updated_at: string;
};

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
        className="h-full bg-accent rounded-full transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function BookRow({ entry }: { entry: MyBookEntry }) {
  const { book, chapter, progress_value, total_value, updated_at } = entry;
  const href = `/listen?id=${book.id}&chapter=${chapter.id}`;
  const pct =
    total_value && total_value > 0
      ? Math.round((progress_value / total_value) * 100)
      : null;

  return (
    <Link
      href={href}
      className="flex gap-3 p-3 bg-surface dark:bg-raised rounded-xl border border-hairline-soft dark:border-hairline/80 hover:shadow-md hover:border-accent/40 dark:hover:border-accent/40 transition-all group"
    >
      {/* Cover */}
      <div className="w-14 h-[4.67rem] shrink-0 rounded-lg overflow-hidden bg-linear-to-br from-raised to-raised-hi dark:from-raised dark:to-raised-hi relative">
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

      <div className="flex items-center self-center shrink-0 text-text-faint dark:text-text-dim group-hover:text-accent transition-colors">
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
      </div>
    </Link>
  );
}

export default function MyBooksPage() {
  const [loggedIn, setLoggedIn] = useState(() => isLoggedIn());

  useEffect(() => {
    const h = () => setLoggedIn(isLoggedIn());
    window.addEventListener("auth-change", h);
    return () => window.removeEventListener("auth-change", h);
  }, []);

  const { data, isLoading, error } = useQuery({
    queryKey: ["my-books"],
    queryFn: async () => {
      try {
        const result = await api.getMyBooks();
        await setCachedMyBooks(result);
        return result as MyBookEntry[];
      } catch {
        const cached = await getCachedMyBooks();
        return (cached as MyBookEntry[] | null) ?? [];
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
          className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-dim transition-colors"
        >
          Đăng nhập
        </Link>
      </div>
    );
  }

  const entries = data ?? [];

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-text dark:text-text">
            Truyện của tôi
          </h1>
          <p className="text-sm text-text-mute dark:text-text-mute mt-0.5">
            Tiếp tục đọc hoặc nghe từ nơi bạn dừng lại
          </p>
        </div>
        {entries.length > 0 && (
          <span className="text-xs font-medium text-text-mute bg-raised dark:bg-raised px-3 py-1.5 rounded-full">
            {entries.length} truyện
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex flex-col items-center gap-3 py-24">
          <Spinner className="w-8 h-8 text-accent" />
          <p className="text-sm text-text-mute">Đang tải...</p>
        </div>
      )}

      {error && entries.length === 0 && (
        <div className="text-center py-16">
          <p className="text-vermillion text-sm">
            Không thể tải danh sách. Vui lòng thử lại.
          </p>
        </div>
      )}

      {!isLoading && entries.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <svg
            className="w-14 h-14 text-text-dim dark:text-text mb-4"
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
          <p className="text-text-mute dark:text-text-mute mb-2">
            Bạn chưa đọc hoặc nghe truyện nào
          </p>
          <Link
            href="/"
            className="text-sm text-accent dark:text-accent hover:underline"
          >
            Khám phá thư viện →
          </Link>
        </div>
      )}

      <div className="space-y-2.5">
        {entries.map((entry) => (
          <BookRow key={entry.book.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
