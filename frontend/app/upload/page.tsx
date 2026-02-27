"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UploadZone } from "@/components/upload/UploadZone";
import { VoiceSelector } from "@/components/upload/VoiceSelector";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";

export default function UploadPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [voice, setVoice] = useState("vi-VN-HoaiMyNeural");
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setIsUploading(true);
    setError(null);
    try {
      const result = await api.uploadEpub(file, voice);
      router.push(`/books/${result.book_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload thất bại");
      setIsUploading(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mb-6">
        <Link href="/" className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">
          Thư viện
        </Link>
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-gray-900 dark:text-gray-100 font-medium">Tải lên</span>
      </nav>

      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm p-6 sm:p-8">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-indigo-100 dark:bg-indigo-950 rounded-xl mb-3">
            <svg className="w-6 h-6 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Tải lên truyện EPUB</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Chọn file và giọng đọc để bắt đầu</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <UploadZone onFile={setFile} disabled={isUploading} />

          {file && (
            <div className="flex items-center gap-3 p-3 bg-indigo-50 dark:bg-indigo-950/50 rounded-xl border border-indigo-100 dark:border-indigo-900 animate-in">
              <div className="w-9 h-9 bg-indigo-100 dark:bg-indigo-900 rounded-lg flex items-center justify-center shrink-0">
                <svg className="w-4.5 h-4.5 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-indigo-900 dark:text-indigo-200 truncate">{file.name}</p>
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
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                  </svg>
                </button>
              )}
            </div>
          )}

          <VoiceSelector value={voice} onChange={setVoice} />

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/50 px-4 py-3 rounded-xl border border-red-100 dark:border-red-900">
            <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
            </svg>
            {error}
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
                Đang tải lên...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
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
            <svg className="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Tải lên</p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">File EPUB</p>
        </div>
        <div className="text-center p-3">
          <div className="inline-flex items-center justify-center w-8 h-8 bg-purple-100 dark:bg-purple-950 rounded-lg mb-2">
            <svg className="w-4 h-4 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Chuyển đổi</p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">AI TTS</p>
        </div>
        <div className="text-center p-3">
          <div className="inline-flex items-center justify-center w-8 h-8 bg-green-100 dark:bg-green-950 rounded-lg mb-2">
            <svg className="w-4 h-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Nghe & Đọc</p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">Mọi lúc</p>
        </div>
      </div>
    </div>
  );
}
