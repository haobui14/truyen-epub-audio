"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Book } from "@/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { GenreTag } from "@/components/books/GenreManager";
import { isAdmin } from "@/lib/auth";
import { api } from "@/lib/api";

export function BookCard({ book, priority }: { book: Book; priority?: boolean }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [admin, setAdmin] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    const sync = () => setAdmin(isAdmin());
    sync();
    window.addEventListener("auth-change", sync);
    return () => window.removeEventListener("auth-change", sync);
  }, []);

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteBook(book.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });

  return (
    <>
      <div className="relative group">
        <Link
          href={`/book?id=${book.id}`}
          className="block bg-surface dark:bg-raised rounded-2xl shadow-sm card-hover overflow-hidden border border-hairline-soft dark:border-hairline/60 hover:border-accent/30 dark:hover:border-accent/40/60 transition-colors duration-200"
        >
          <div className="aspect-2/3 bg-linear-to-br from-raised to-raised-hi dark:from-raised dark:to-raised-hi relative overflow-hidden">
            {book.cover_url ? (
              <Image
                src={book.cover_url}
                alt={book.title}
                fill
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                className="object-cover group-hover:scale-105 transition-transform duration-300"
                priority={priority}
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-accent dark:text-accent-dim px-3">
                <svg
                  className="w-12 h-12 mb-2"
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
                <span className="text-xs font-medium text-accent dark:text-accent text-center line-clamp-2">
                  {book.title}
                </span>
              </div>
            )}
          </div>
          <div className="p-3 flex flex-col">
            {/* Title - fixed 2 lines max */}
            <h3
              className="font-semibold text-text dark:text-text text-sm leading-[1.3] h-[calc(1.3em*2)] line-clamp-2 mb-1 group-hover:text-accent dark:group-hover:text-accent transition-colors"
              title={book.title}
            >
              {book.title}
            </h3>
            {/* Author - fixed 1 line */}
            <p
              className="text-xs leading-[1.4] h-[1.4em] text-text-mute dark:text-text-mute mb-1.5 truncate"
              title={book.author || ""}
            >
              {book.author || "\u00A0"}
            </p>
            <div className="flex items-center gap-1 text-xs text-text-mute dark:text-text-mute">
              <svg
                className="w-3 h-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h7"
                />
              </svg>
              <span>{book.total_chapters} chương</span>
            </div>
            {book.genres && book.genres.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {book.genres.slice(0, 2).map((g) => (
                  <GenreTag key={g.id} genre={g} />
                ))}
                {book.genres.length > 2 && (
                  <span className="text-[10px] text-text-mute dark:text-text-mute leading-5">
                    +{book.genres.length - 2}
                  </span>
                )}
              </div>
            )}
          </div>
        </Link>

        {/* Delete button - visible on hover for admins only */}
        {admin && (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowConfirm(true);
            }}
            className="absolute top-2 left-2 min-h-11 min-w-11 rounded-lg bg-black/50 text-white/80 hover:bg-vermillion hover:text-white opacity-0 group-hover:opacity-100 transition-[opacity,background-color,color,transform] duration-200 active:scale-[0.96] backdrop-blur-sm z-10"
            title="Xóa truyện"
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
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
        )}
      </div>

      <ConfirmDialog
        open={showConfirm}
        title="Xóa truyện?"
        message={`Bạn có chắc muốn xóa "${book.title}"? Tất cả dữ liệu bao gồm file EPUB, ảnh bìa và audio sẽ bị xóa vĩnh viễn.`}
        confirmLabel={deleteMutation.isPending ? "Đang xóa..." : "Xóa truyện"}
        onConfirm={() => {
          deleteMutation.mutate();
          setShowConfirm(false);
        }}
        onCancel={() => setShowConfirm(false)}
      />
    </>
  );
}
