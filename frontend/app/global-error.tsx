"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="vi">
      <body className="bg-gray-50 dark:bg-gray-950 flex items-center justify-center min-h-screen p-4">
        <div className="text-center max-w-sm">
          <p className="text-5xl mb-4">⚠️</p>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-2">
            Đã xảy ra lỗi
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            {error?.message || "Ứng dụng gặp sự cố. Vui lòng thử lại."}
          </p>
          <button
            onClick={reset}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 active:scale-95 transition"
          >
            Thử lại
          </button>
        </div>
      </body>
    </html>
  );
}
