"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UploadZone } from "@/components/upload/UploadZone";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";
import { isLoggedIn, isAdmin } from "@/lib/auth";

export default function UploadPage() {
  const router = useRouter();

  useEffect(() => {
    if (!isLoggedIn() || !isAdmin()) router.replace("/");
  }, [router]);
  const [file, setFile] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleCover = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setCover(f);
    if (f) {
      const url = URL.createObjectURL(f);
      setCoverPreview(url);
    } else {
      setCoverPreview(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(0);
    setError(null);
    try {
      const result = await api.uploadEpubWithProgress(
        file,
        "vi-VN-HoaiMyNeural",
        cover,
        setUploadProgress,
      );
      router.push(`/book?id=${result.book_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload thất bại");
      setIsUploading(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mb-6">
        <Link
          href="/"
          className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
        >
          Thư viện
        </Link>
        <svg
          className="w-3.5 h-3.5"
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
        <span className="text-gray-900 dark:text-gray-100 font-medium">
          Tải lên
        </span>
      </nav>

      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm p-6 sm:p-8">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-indigo-100 dark:bg-indigo-950 rounded-xl mb-3">
            <svg
              className="w-6 h-6 text-indigo-600 dark:text-indigo-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            Tải lên truyện
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Hỗ trợ EPUB, PDF (kể cả ảnh scan) và TXT
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <UploadZone onFile={setFile} disabled={isUploading} />

          {/* Cover image picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Ảnh bìa{" "}
              <span className="text-gray-400 font-normal">(tùy chọn)</span>
            </label>
            <div className="flex items-center gap-4">
              {coverPreview ? (
                <div className="relative w-16 h-20 shrink-0">
                  <img
                    src={coverPreview}
                    alt="Cover preview"
                    className="w-full h-full object-cover rounded-lg border border-gray-200 dark:border-gray-700"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setCover(null);
                      setCoverPreview(null);
                    }}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 transition-colors"
                  >
                    <svg
                      className="w-3 h-3"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                  </button>
                </div>
              ) : (
                <div className="w-16 h-20 shrink-0 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
                  <svg
                    className="w-6 h-6 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                </div>
              )}
              <label className="flex-1 cursor-pointer">
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-600 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors text-sm text-gray-600 dark:text-gray-400">
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
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
                  </svg>
                  {cover ? cover.name : "Chọn ảnh bìa (JPG, PNG)"}
                </div>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleCover}
                  disabled={isUploading}
                  className="sr-only"
                />
              </label>
            </div>
          </div>

          {file && (
            <div className="flex items-center gap-3 p-3 bg-indigo-50 dark:bg-indigo-950/50 rounded-xl border border-indigo-100 dark:border-indigo-900 animate-in">
              <div className="w-9 h-9 bg-indigo-100 dark:bg-indigo-900 rounded-lg flex items-center justify-center shrink-0">
                <svg
                  className="w-4.5 h-4.5 text-indigo-600 dark:text-indigo-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-indigo-900 dark:text-indigo-200 truncate">
                  {file.name}
                </p>
                <p className="text-xs text-indigo-500">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                </p>
              </div>
              {!isUploading && (
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  className="p-1 text-indigo-400 hover:text-indigo-600 hover:bg-indigo-100 dark:hover:bg-indigo-900 rounded-lg transition-colors"
                >
                  <svg
                    className="w-4 h-4"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/50 px-4 py-3 rounded-xl border border-red-100 dark:border-red-900">
              <svg
                className="w-4 h-4 shrink-0"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
              </svg>
              {error}
            </div>
          )}

          {isUploading && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>
                  {uploadProgress < 100 ? "Đang tải lên..." : "Đang xử lý..."}
                </span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-200"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={!file || isUploading}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white font-semibold py-3 rounded-xl hover:bg-indigo-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow-md"
          >
            {isUploading ? (
              <>
                <Spinner className="w-4 h-4" />
                {uploadProgress < 100
                  ? `Đang tải lên... ${uploadProgress}%`
                  : "Đang xử lý..."}
              </>
            ) : (
              <>
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
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                  />
                </svg>
                Tải lên và chuyển đổi
              </>
            )}
          </button>
        </form>
      </div>

      {/* Info section */}
      <div className="mt-6 grid grid-cols-3 gap-4">
        <div className="text-center p-3">
          <div className="inline-flex items-center justify-center w-8 h-8 bg-blue-100 dark:bg-blue-950 rounded-lg mb-2">
            <svg
              className="w-4 h-4 text-blue-600 dark:text-blue-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Tải lên
          </p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
            EPUB · PDF · TXT
          </p>
        </div>
        <div className="text-center p-3">
          <div className="inline-flex items-center justify-center w-8 h-8 bg-purple-100 dark:bg-purple-950 rounded-lg mb-2">
            <svg
              className="w-4 h-4 text-purple-600 dark:text-purple-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
            </svg>
          </div>
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Chuyển đổi
          </p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
            AI TTS
          </p>
        </div>
        <div className="text-center p-3">
          <div className="inline-flex items-center justify-center w-8 h-8 bg-green-100 dark:bg-green-950 rounded-lg mb-2">
            <svg
              className="w-4 h-4 text-green-600 dark:text-green-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Nghe & Đọc
          </p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
            Mọi lúc
          </p>
        </div>
      </div>
    </div>
  );
}
