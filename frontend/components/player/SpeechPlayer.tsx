"use client";
import { useState } from "react";
import Image from "next/image";
import { usePlayerContext } from "@/context/PlayerContext";
import { SpeedControl } from "./SpeedControl";
import { Spinner } from "@/components/ui/Spinner";

const SLEEP_PRESETS = [15, 30, 45, 60] as const;

const VOICE_OPTIONS = [
  { value: "vi-VN-HoaiMyNeural", label: "HoaiMy", sub: "Nữ" },
  { value: "vi-VN-NamMinhNeural", label: "NamMinh", sub: "Nam" },
  { value: "gtts", label: "Mặc định", sub: "gTTS" },
] as const;

export function SpeechPlayer() {
  const {
    track,
    voice,
    setVoice,
    isPlaying,
    isBuffering,
    isOffline,
    mode,
    progress,
    chunkIndex,
    totalChunks,
    rate,
    toggle,
    changeRate,
    restartChunk,
    cacheStatuses,
    sleepRemaining,
    setSleepTimer,
    cancelSleepTimer,
  } = usePlayerContext();

  const [activeTab, setActiveTab] = useState<"listen" | "read">("listen");
  const [showTimerPanel, setShowTimerPanel] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("");

  // Null-guard: track should always be set before this component renders
  if (!track) return null;

  const { chapter, book, text, isLoadingText, onPrev, onNext } = track;

  const offlineReadyCount = Object.values(cacheStatuses).filter(
    (s) => s === "cached",
  ).length;
  const downloadingCount = Object.values(cacheStatuses).filter(
    (s) => s === "downloading",
  ).length;

  function handleVoiceChange(newVoice: string) {
    setVoice(newVoice);
    restartChunk();
  }

  const ready = !isLoadingText && (mode === "full" || !!text);
  const showSpinner = isLoadingText || isBuffering;
  const progressPct = Math.round(progress * 100);

  /** Format seconds to M:SS */
  function fmtTime(s: number) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  function handleSetTimer(mins: number) {
    setSleepTimer(mins);
    setShowTimerPanel(false);
    setCustomMinutes("");
  }

  function handleCustomTimer() {
    const mins = parseFloat(customMinutes);
    if (!isNaN(mins) && mins > 0) handleSetTimer(mins);
  }

  return (
    <div className="w-full rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
      {/* Cover + chapter info header */}
      <div className="flex items-center gap-4 px-5 py-4 border-b border-gray-100 dark:border-gray-800">
        <div className="w-14 h-14 rounded-xl overflow-hidden bg-indigo-100 dark:bg-indigo-950 shrink-0 shadow">
          {book.cover_url ? (
            <Image
              src={book.cover_url}
              alt={book.title}
              width={56}
              height={56}
              className="object-cover w-full h-full"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-indigo-300">
              <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-indigo-500 dark:text-indigo-400 truncate">
            {book.title}
          </p>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug mt-0.5 line-clamp-2">
            {chapter.title}
          </h2>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            Chương {chapter.chapter_index + 1}
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-100 dark:border-gray-800">
        <button
          onClick={() => setActiveTab("listen")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors ${
            activeTab === "listen"
              ? "text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400 -mb-px"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          }`}
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" />
          </svg>
          Nghe
        </button>
        <button
          onClick={() => setActiveTab("read")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors ${
            activeTab === "read"
              ? "text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400 -mb-px"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          }`}
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
          Đọc
        </button>
      </div>

      {/* ── LISTEN TAB ── */}
      {activeTab === "listen" && (
        <div className="px-5 py-5 flex flex-col gap-5">
          {/* Progress */}
          <div>
            <div className="h-1 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mt-1.5">
              {totalChunks > 0 ? (
                mode === "full" ? (
                  <>
                    <span className="flex items-center gap-1">
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"
                        title="Đang phát từ bộ nhớ"
                      />
                      {fmtTime(chunkIndex)}
                    </span>
                    <span>{fmtTime(totalChunks)}</span>
                  </>
                ) : (
                  <>
                    <span>
                      Đoạn {chunkIndex + 1} / {totalChunks}
                    </span>
                    <span>{progressPct}%</span>
                  </>
                )
              ) : (
                <span className="text-gray-300 dark:text-gray-600 italic">
                  {isLoadingText ? "Đang tải nội dung..." : "Đang chuẩn bị..."}
                </span>
              )}
            </div>
          </div>

          {/* Playback controls */}
          <div className="flex items-center justify-center gap-8">
            <button
              onClick={onPrev ?? undefined}
              disabled={!onPrev}
              className="p-2 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800 disabled:opacity-25 transition-all"
              title="Chương trước"
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
              </svg>
            </button>

            <button
              onClick={toggle}
              disabled={!ready}
              className="w-14 h-14 bg-indigo-600 text-white rounded-full flex items-center justify-center hover:bg-indigo-700 active:scale-95 disabled:opacity-40 transition-all shadow-md shadow-indigo-200 dark:shadow-indigo-900"
              title={isPlaying ? "Tạm dừng" : "Phát"}
            >
              {showSpinner ? (
                <Spinner className="w-5 h-5" />
              ) : isPlaying ? (
                <svg
                  className="w-6 h-6"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              ) : (
                <svg
                  className="w-6 h-6 ml-0.5"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            <button
              onClick={onNext ?? undefined}
              disabled={!onNext}
              className="p-2 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800 disabled:opacity-25 transition-all"
              title="Chương tiếp"
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </button>
          </div>

          {/* Buffering / offline status */}
          {isBuffering && (
            <p className="text-center text-xs -mt-2 flex items-center justify-center gap-1.5">
              {isOffline ? (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  <span className="text-amber-500 dark:text-amber-400">
                    Mất kết nối, đang chờ...
                  </span>
                </>
              ) : (
                <span className="text-indigo-400 dark:text-indigo-500">
                  Đang tải âm thanh...
                </span>
              )}
            </p>
          )}

          {/* Offline-ready indicator */}
          {(offlineReadyCount > 0 || downloadingCount > 0) && !isBuffering && (
            <p className="text-center text-xs -mt-2 flex items-center justify-center gap-1.5 text-gray-400 dark:text-gray-500">
              {downloadingCount > 0 ? (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                  Đang tải sẵn {downloadingCount} chương lân cận...
                </>
              ) : (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  {offlineReadyCount} chương lân cận sẵn sàng offline
                </>
              )}
            </p>
          )}

          {/* Speed + Voice + Sleep Timer */}
          <div className="flex flex-col gap-3 pt-1 border-t border-gray-100 dark:border-gray-800">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400 dark:text-gray-500 font-medium">
                Tốc độ
              </span>
              <SpeedControl value={rate} onChange={changeRate} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400 dark:text-gray-500 font-medium">
                Giọng đọc
              </span>
              <div className="flex gap-1.5">
                {VOICE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleVoiceChange(opt.value)}
                    title={opt.sub}
                    className={`flex flex-col items-center px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                      voice === opt.value
                        ? "bg-indigo-600 border-indigo-600 text-white"
                        : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400"
                    }`}
                  >
                    <span>{opt.label}</span>
                    <span
                      className={`text-[10px] font-normal ${voice === opt.value ? "text-indigo-200" : "text-gray-400"}`}
                    >
                      {opt.sub}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Sleep timer row */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400 dark:text-gray-500 font-medium">
                Hẹn giờ tắt
              </span>
              <button
                onClick={() => setShowTimerPanel((v) => !v)}
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors ${
                  sleepRemaining !== null
                    ? "bg-amber-500 border-amber-500 text-white"
                    : showTimerPanel
                      ? "bg-indigo-50 dark:bg-indigo-950 border-indigo-300 dark:border-indigo-700 text-indigo-600 dark:text-indigo-400"
                      : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400"
                }`}
              >
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
                    d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                  />
                </svg>
                {sleepRemaining !== null ? fmtTime(sleepRemaining) : "Hẹn giờ"}
              </button>
            </div>

            {/* Timer panel */}
            {showTimerPanel && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 flex flex-col gap-2.5">
                {sleepRemaining !== null && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-medium">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                      Tắt sau {fmtTime(sleepRemaining)}
                    </span>
                    <button
                      onClick={() => {
                        cancelSleepTimer();
                        setShowTimerPanel(false);
                      }}
                      className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors text-xs font-medium"
                    >
                      Hủy
                    </button>
                  </div>
                )}

                {/* Preset buttons */}
                <div className="grid grid-cols-4 gap-1.5">
                  {SLEEP_PRESETS.map((mins) => (
                    <button
                      key={mins}
                      onClick={() => handleSetTimer(mins)}
                      className="py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-indigo-50 dark:hover:bg-indigo-950 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                    >
                      {mins < 60 ? `${mins}p` : "1g"}
                    </button>
                  ))}
                </div>

                {/* Custom input */}
                <div className="flex gap-1.5">
                  <input
                    type="number"
                    min="1"
                    max="300"
                    placeholder="Nhập số phút..."
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCustomTimer()}
                    className="flex-1 px-2.5 py-1.5 rounded-lg text-xs border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 placeholder-gray-400 focus:outline-none focus:border-indigo-400 dark:focus:border-indigo-500"
                  />
                  <button
                    onClick={handleCustomTimer}
                    disabled={
                      !customMinutes ||
                      isNaN(parseFloat(customMinutes)) ||
                      parseFloat(customMinutes) <= 0
                    }
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                  >
                    Đặt
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── READ TAB ── */}
      {activeTab === "read" && (
        <div className="px-5 py-5">
          {isLoadingText ? (
            <div className="flex flex-col items-center gap-3 py-12 text-gray-400">
              <Spinner className="w-6 h-6 text-indigo-500" />
              <p className="text-sm">Đang tải nội dung...</p>
            </div>
          ) : text ? (
            <div className="max-h-[65vh] overflow-y-auto pr-1 scrollbar-thin">
              <div className="prose prose-sm dark:prose-invert max-w-none">
                {text.split(/\n+/).map((para, i) =>
                  para.trim() ? (
                    <p
                      key={i}
                      className="text-gray-700 dark:text-gray-300 leading-relaxed text-[15px] mb-3 last:mb-0"
                    >
                      {para.trim()}
                    </p>
                  ) : null,
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-12 text-gray-400">
              <svg
                className="w-10 h-10 text-gray-200 dark:text-gray-700"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p className="text-sm">Không có nội dung cho chương này.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
