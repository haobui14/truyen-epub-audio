"use client";
import Link from "next/link";
import Image from "next/image";
import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { getCachedBooks, cacheBooks } from "@/lib/bookCache";
import { isAdmin, isLoggedIn } from "@/lib/auth";
import { SpotlightCard } from "@/components/books/SpotlightCard";
import { BookScrollRow } from "@/components/books/BookScrollRow";
import { getColorClasses } from "@/components/books/GenreManager";
import { Spinner } from "@/components/ui/Spinner";

// ── Recent-progress mini-card ─────────────────────────────────────────────────
function RecentCard({
  item,
}: {
  item: {
    book: {
      id: string;
      title: string;
      author?: string;
      cover_url?: string;
      total_chapters: number;
    };
    chapter: { id: string; chapter_index: number; title: string };
    updated_at: string;
  };
}) {
  const { book, chapter } = item;
  const isLastChapter = chapter.chapter_index + 1 >= book.total_chapters;

  return (
    <Link
      href={`/book?id=${book.id}`}
      className="flex-none w-28 sm:w-33 group relative"
    >
      <div className="aspect-2/3 rounded-md overflow-hidden bg-raised relative ring-1 ring-hairline-soft mb-2 shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
        {book.cover_url ? (
          <Image
            src={book.cover_url}
            alt={book.title}
            fill
            sizes="132px"
            className="object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg
              className="w-8 h-8 text-text-faint"
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

        {isLastChapter && (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 flex justify-center">
            <span className="font-mono text-[9px] tracking-widest uppercase px-1.5 py-0.5 rounded-sm bg-gold text-ink shadow-md">
              ✓ Hoàn
            </span>
          </div>
        )}

        {!isLastChapter && book.total_chapters > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-black/40">
            <div
              className="h-full bg-accent transition-all"
              style={{
                width: `${Math.round(((chapter.chapter_index + 1) / book.total_chapters) * 100)}%`,
              }}
            />
          </div>
        )}
      </div>

      <p className="text-xs font-semibold text-text line-clamp-2 leading-tight group-hover:text-accent transition-colors">
        {book.title}
      </p>

      <p className="font-mono text-[10px] tracking-wider text-text-faint truncate mt-0.5">
        Ch.{chapter.chapter_index + 1}/{book.total_chapters}
      </p>
    </Link>
  );
}

// ── Greeting helper ───────────────────────────────────────────────────────────
function greetingForHour(h: number): string {
  if (h < 11) return "Chào buổi sáng";
  if (h < 14) return "Chào buổi trưa";
  if (h < 18) return "Chào buổi chiều";
  return "Chào buổi tối";
}

// ── Home page ─────────────────────────────────────────────────────────────────
export default function HomePage() {
  const admin = useSyncExternalStore(
    (cb) => {
      window.addEventListener("auth-change", cb);
      return () => window.removeEventListener("auth-change", cb);
    },
    isAdmin,
    () => false,
  );

  const loggedIn = useSyncExternalStore(
    (cb) => {
      window.addEventListener("auth-change", cb);
      return () => window.removeEventListener("auth-change", cb);
    },
    isLoggedIn,
    () => false,
  );

  const {
    data: books,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["books"],
    queryFn: async () => {
      try {
        const data = await api.listBooks();
        cacheBooks(data).catch(() => {});
        return data;
      } catch {
        const cached = await getCachedBooks();
        if (cached) return cached;
        throw new Error("offline");
      }
    },
    refetchInterval: 10_000,
  });

  const { data: genres } = useQuery({
    queryKey: ["genres"],
    queryFn: api.listGenres,
    staleTime: 60_000,
  });

  const { data: myBooks } = useQuery({
    queryKey: ["my-books"],
    queryFn: api.getMyBooks,
    enabled: loggedIn,
    staleTime: 30_000,
  });

  const hasBooks = books && books.length > 0;
  const featuredBook = books?.find((b) => b.is_featured) ?? books?.[0] ?? null;

  const newBooks = useMemo(() => {
    if (!books) return [];
    return [...books]
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .slice(0, 12);
  }, [books]);

  const genreSections = useMemo(() => {
    if (!books || !genres) return [];
    return genres
      .map((genre) => ({
        genre,
        books: books.filter((b) =>
          (b.genres ?? []).some((g) => g.id === genre.id),
        ),
      }))
      .filter((s) => s.books.length > 0);
  }, [books, genres]);

  const greeting = greetingForHour(new Date().getHours());

  return (
    <div>
      {/* Greeting hero (logged-in only) */}
      {loggedIn && (hasBooks || isLoading) && (
        <div className="mb-7">
          <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-text-mute">
            Tủ sách của bạn
          </p>
          <h1 className="font-display text-3xl sm:text-4xl text-text leading-tight mt-1">
            {greeting}, <span className="italic text-accent">đạo hữu</span>
          </h1>
        </div>
      )}

      {/* Empty-state hero */}
      {!hasBooks && !isLoading && !error && (
        <div className="text-center py-20 sm:py-28">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6 bg-accent/10 ring-1 ring-accent/30 shadow-[0_0_40px_var(--color-accent-glow)] animate-float">
            <svg
              className="w-10 h-10 text-accent"
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
          <h1 className="font-display text-3xl sm:text-4xl text-text mb-3">
            Chào mừng đến{" "}
            <span className="italic text-accent">TruyệnAudio</span>
          </h1>
          <p className="text-text-mute max-w-md mx-auto mb-8 text-base leading-relaxed">
            Tải lên file EPUB để nghe hoặc đọc truyện tiếng Việt với giọng đọc
            AI tự nhiên.
          </p>
          {admin && (
            <Link
              href="/upload"
              className="inline-flex items-center gap-2 bg-accent text-ink font-medium px-6 py-3 rounded-md hover:bg-accent-dim active:scale-[0.98] transition-all shadow-[0_0_24px_var(--color-accent-glow)]"
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
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Tải lên truyện đầu tiên
            </Link>
          )}
        </div>
      )}

      {/* Library section */}
      {(hasBooks || isLoading) && (
        <>
          {hasBooks && featuredBook && (
            <div className="mb-7">
              <SpotlightCard book={featuredBook} />
            </div>
          )}

          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-text-mute">
                Khám phá
              </p>
              <h2 className="font-display text-xl text-text leading-tight mt-0.5">
                Thư viện đang chờ
              </h2>
            </div>
            {books && (
              <div className="flex items-center gap-2">
                {admin && (
                  <Link
                    href="/admin/manage-books"
                    className="p-2 rounded-md text-text-faint hover:text-accent hover:bg-raised transition-colors"
                    title="Quản lý truyện"
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
                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                  </Link>
                )}
                <span className="font-mono text-[10px] tracking-widest uppercase text-text-mute bg-raised border border-hairline-soft px-2.5 py-1 rounded-sm tabular-nums">
                  {books.length} truyện
                </span>
              </div>
            )}
          </div>
        </>
      )}

      {isLoading && (
        <div className="flex flex-col items-center gap-3 py-24">
          <Spinner className="w-8 h-8 text-accent" />
          <p className="text-sm text-text-mute">Đang tải thư viện...</p>
        </div>
      )}

      {error && (
        <div className="text-center py-24">
          <svg
            className="w-12 h-12 mx-auto mb-3 text-vermillion/60"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
          <p className="text-vermillion font-medium">
            Không thể tải danh sách truyện
          </p>
          <p className="text-sm text-text-faint mt-1">
            Vui lòng kiểm tra kết nối và thử lại.
          </p>
        </div>
      )}

      {/* Sections */}
      {hasBooks && (
        <>
          {loggedIn && myBooks && myBooks.length > 0 && (
            <section className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-4 rounded-sm bg-accent shrink-0 shadow-[0_0_10px_var(--color-accent-glow)]" />
                  <h2 className="font-display text-lg text-text">Đang nghe</h2>
                </div>
                <Link
                  href="/profile"
                  className="flex items-center gap-0.5 font-mono text-[10px] tracking-widest uppercase text-accent hover:text-accent-dim shrink-0"
                >
                  Trang cá nhân
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </Link>
              </div>
              <div className="flex gap-3 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] pb-1">
                {myBooks.map((item) => (
                  <RecentCard key={item.book.id} item={item} />
                ))}
              </div>
            </section>
          )}

          <BookScrollRow
            title="Mới thêm"
            seeAllHref="/search"
            books={newBooks}
          />
          {genreSections.map(({ genre, books: genreBooks }) => (
            <BookScrollRow
              key={genre.id}
              title={genre.name}
              seeAllHref={`/search?genre=${genre.id}`}
              colorDot={getColorClasses(genre.color).dot}
              books={genreBooks}
            />
          ))}
        </>
      )}
    </div>
  );
}
