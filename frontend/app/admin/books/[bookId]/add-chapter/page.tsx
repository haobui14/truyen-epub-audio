"use client";
import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isAdmin } from "@/lib/auth";
import { Spinner } from "@/components/ui/Spinner";

export default function AddChapterPage() {
  const router = useRouter();
  const params = useParams();
  const bookId = params.bookId as string;

  const [chapterIndex, setChapterIndex] = useState("");
  const [title, setTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin()) router.replace("/");
  }, [router]);

  const { data: book } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
    enabled: !!bookId,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const index = parseInt(chapterIndex, 10);
    if (isNaN(index) || index < 1) {
      setError("Số chương phải là số nguyên dương.");
      return;
    }
    if (!title.trim()) {
      setError("Tiêu đề chương không được để trống.");
      return;
    }
    if (!textContent.trim()) {
      setError("Nội dung chương không được để trống.");
      return;
    }

    setIsSubmitting(true);
    try {
      await api.createChapter(bookId, {
        chapter_index: index,
        title: title.trim(),
        text_content: textContent.trim(),
      });
      router.push(`/books/${bookId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Lỗi không xác định";
      if (message.includes("409") || message.toLowerCase().includes("conflict")) {
        setError(`Chương số ${index} đã tồn tại. Vui lòng chọn số chương khác.`);
      } else {
        setError(message);
      }
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 mb-6">
        <Link href="/" className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">
          Thư viện
        </Link>
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {book ? (
          <Link
            href={`/books/${bookId}`}
            className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors truncate max-w-40"
          >
            {book.title}
          </Link>
        ) : (
          <span className="truncate max-w-40">Sách</span>
        )}
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-gray-700 dark:text-gray-200 font-medium">Thêm chương</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-6">Thêm chương mới</h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Chapter number */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            Số chương
          </label>
          <input
            type="number"
            min={1}
            value={chapterIndex}
            onChange={(e) => setChapterIndex(e.target.value)}
            placeholder="Ví dụ: 1"
            required
            className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
          />
        </div>

        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            Tiêu đề chương
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ví dụ: Chương 1: Khởi đầu"
            required
            className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
          />
        </div>

        {/* Content */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            Nội dung chương
          </label>
          <textarea
            value={textContent}
            onChange={(e) => setTextContent(e.target.value)}
            placeholder="Nhập nội dung chương tại đây..."
            required
            rows={16}
            className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition resize-y font-mono text-sm leading-relaxed"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex items-center gap-2 bg-indigo-600 text-white font-medium px-5 py-2.5 rounded-lg hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
          >
            {isSubmitting ? (
              <>
                <Spinner className="w-4 h-4" />
                Đang lưu...
              </>
            ) : (
              "Lưu chương"
            )}
          </button>
          <Link
            href={`/books/${bookId}`}
            className="px-5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-sm"
          >
            Hủy
          </Link>
        </div>
      </form>
    </div>
  );
}
