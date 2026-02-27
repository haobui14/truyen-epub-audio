"use client";
import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Book } from "@/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/api";

export function BookCard({ book }: { book: Book }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const queryClient = useQueryClient();

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
          href={`/books/${book.id}`}
          className="block bg-white dark:bg-gray-800 rounded-xl shadow-sm hover:shadow-lg card-hover overflow-hidden border border-gray-100 dark:border-gray-700/80"
        >
          <div className="aspect-2/3 bg-linear-to-br from-indigo-50 to-purple-50 dark:from-indigo-950 dark:to-purple-950 relative overflow-hidden">
            {book.cover_url ? (
              <Image
                src={book.cover_url}
                alt={book.title}
                fill
                className="object-cover group-hover:scale-105 transition-transform duration-300"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-indigo-300 dark:text-indigo-700 px-3">
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
                <span className="text-xs font-medium text-indigo-400 dark:text-indigo-600 text-center line-clamp-2">
                  {book.title}
                </span>
              </div>
            )}
          </div>
          <div className="p-3 flex flex-col">
            {/* Title - fixed 2 lines max */}
            <h3
              className="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-[1.3] h-[calc(1.3em*2)] line-clamp-2 mb-1 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors"
              title={book.title}
            >
              {book.title}
            </h3>
            {/* Author - fixed 1 line */}
            <p
              className="text-xs leading-[1.4] h-[1.4em] text-gray-500 dark:text-gray-400 mb-1.5 truncate"
              title={book.author || ""}
            >
              {book.author || "\u00A0"}
            </p>
            <div className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500">
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
          </div>
        </Link>

        {/* Delete button - visible on hover */}
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowConfirm(true);
          }}
          className="absolute top-2 left-2 p-1.5 rounded-lg bg-black/50 text-white/80 hover:bg-red-600 hover:text-white opacity-0 group-hover:opacity-100 transition-all duration-200 backdrop-blur-sm z-10"
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
