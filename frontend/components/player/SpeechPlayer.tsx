"use client";
import { useState } from "react";
import Image from "next/image";
import { usePlayerContext } from "@/context/PlayerContext";
import { SpeedControl } from "./SpeedControl";
import { Spinner } from "@/components/ui/Spinner";
import { useNativeTTSVoices } from "@/hooks/useNativeTTSPlayer";
import { isNativePlatform } from "@/lib/capacitor";

const SLEEP_PRESETS = [15, 30, 45, 60] as const;

const BACKEND_VOICES = [
  { value: "vi-VN-HoaiMyNeural", label: "HoaiMy", sub: "Nữ" },
  { value: "vi-VN-NamMinhNeural", label: "NamMinh", sub: "Nam" },
  { value: "gtts", label: "gTTS", sub: "Mặc định" },
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
    seekChunk,
    cacheStatuses,
    sleepRemaining,
    setSleepTimer,
    cancelSleepTimer,
  } = usePlayerContext();

  const nativeVoices = useNativeTTSVoices("vi");
  const isNative = isNativePlatform();

  const [showTimerPanel, setShowTimerPanel] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("");

  if (!track) return null;

  const { chapter, book, isLoadingText, onPrev, onNext } = track;

  const downloadingCount = Object.values(cacheStatuses).filter(
    (s) => s === "downloading",
  ).length;

  function handleVoiceChange(newVoice: string) {
    setVoice(newVoice);
    restartChunk();
  }

  const ready = !isLoadingText && (mode === "full" || !!track.text);
  const progressPct = Math.round(progress * 100);

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

  function handleProgressClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!ready || totalChunks === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    if (mode === "full") {
      // Full mode: delta in "5% units" (20 = full span)
      seekChunk((fraction - progress) * 20);
    } else {
      seekChunk(Math.round(fraction * totalChunks) - chunkIndex);
    }
  }

  return (
    <div className="w-full rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
      {/* ── HEADER ── */}
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 dark:border-gray-800">
        <div className="w-12 h-12 rounded-xl overflow-hidden bg-indigo-100 dark:bg-indigo-950 shrink-0 shadow-sm">
          {book.cover_url ? (
            <Image
              src={book.cover_url}
              alt={book.title}
              width={48}
              height={48}
              className="object-cover w-full h-full"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-indigo-300">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-indigo-500 dark:text-indigo-400 truncate leading-none mb-0.5">
            {book.title}
          </p>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug line-clamp-2">
            {chapter.title}
          </h2>
        </div>
      </div>

      {/* ── PLAYER ── */}
      <div className="px-5 py-5 flex flex-col gap-4">
        {/* Progress bar */}
        <div>
          <div
            className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden cursor-pointer"
            title={`${progressPct}%`}
            onClick={handleProgressClick}
          >
            <div
              className="h-full bg-indigo-500 rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex justify-between items-center mt-1.5">
            {totalChunks > 0 ? (
              mode === "full" ? (
                <>
                  <span className="text-[11px] text-gray-400 dark:text-gray-500 flex items-center gap-1">
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"
                      title="Từ bộ nhớ"
                    />
                    {fmtTime(chunkIndex)}
                  </span>
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">
                    {fmtTime(totalChunks)}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">
                    {chunkIndex + 1} / {totalChunks}
                  </span>
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">
                    {progressPct}%
                  </span>
                </>
              )
            ) : (
              <span className="text-[11px] text-gray-300 dark:text-gray-600 italic">
                {isLoadingText ? "Đang tải..." : "Sẵn sàng"}
              </span>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-4">
          {/* Prev chapter */}
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

          {/* Seek back 5% */}
          <button
            onClick={() => seekChunk(-1)}
            disabled={!ready || totalChunks === 0}
            className="p-1.5 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800 disabled:opacity-25 transition-all"
            title="Lùi 5%"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z" />
            </svg>
          </button>

          {/* Play / Pause */}
          <button
            onClick={toggle}
            disabled={!ready}
            className="w-14 h-14 bg-indigo-600 text-white rounded-full flex items-center justify-center hover:bg-indigo-700 active:scale-95 disabled:opacity-40 transition-all shadow-md shadow-indigo-200 dark:shadow-indigo-900"
            title={isPlaying ? "Tạm dừng" : "Phát"}
          >
            {isLoadingText || isBuffering ? (
              <Spinner className="w-5 h-5" />
            ) : isPlaying ? (
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
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

          {/* Seek forward 5% */}
          <button
            onClick={() => seekChunk(1)}
            disabled={!ready || totalChunks === 0}
            className="p-1.5 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800 disabled:opacity-25 transition-all"
            title="Tiến 5%"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
            </svg>
          </button>

          {/* Next chapter */}
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

        {/* Status line — buffering / offline / cache */}
        <div className="flex items-center justify-center h-4 -mt-1">
          {isBuffering ? (
            <span className="flex items-center gap-1.5 text-xs">
              {isOffline ? (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  <span className="text-amber-500 dark:text-amber-400">
                    Mất kết nối, đang chờ...
                  </span>
                </>
              ) : (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                  <span className="text-indigo-400 dark:text-indigo-500">
                    Đang tải âm thanh...
                  </span>
                </>
              )}
            </span>
          ) : downloadingCount > 0 ? (
            <span className="flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-300 animate-pulse" />
              Đang tải sẵn {downloadingCount} chương...
            </span>
          ) : null}
        </div>

        {/* ── CONTROLS STRIP ── */}
        <div className="flex flex-col gap-3 pt-2 border-t border-gray-100 dark:border-gray-800">
          {/* Speed */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400 dark:text-gray-500 font-medium w-16 shrink-0">
              Tốc độ
            </span>
            <SpeedControl value={rate} onChange={changeRate} />
          </div>

          {/* Voices — all in one row, grouped */}
          <div className="flex items-start gap-2">
            <span className="text-xs text-gray-400 dark:text-gray-500 font-medium w-16 shrink-0 pt-1">
              Giọng
            </span>
            <div className="flex gap-1.5 flex-wrap">
              {/* Backend voices (indigo) */}
              {BACKEND_VOICES.map((opt) => (
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
                  {opt.label}
                </button>
              ))}

              {/* Divider if native voices exist */}
              {isNative && (
                <span className="self-center text-gray-200 dark:text-gray-700 text-xs select-none">
                  |
                </span>
              )}

              {/* Native (Capacitor) voices — shown only in app */}
              {isNative && (
                <>
                  <button
                    onClick={() => handleVoiceChange("native:vi-VN-default")}
                    title="Giọng thiết bị — không cần mạng"
                    className={`flex flex-col items-center px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                      voice === "native:vi-VN-default"
                        ? "bg-emerald-600 border-emerald-600 text-white"
                        : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-400"
                    }`}
                  >
                    Thiết bị
                  </button>
                  {nativeVoices.map((nv) => {
                    const nvKey = `native:${nv.index}`;
                    const label = nv.name
                      .replace(/^(Google|Samsung)\s+/i, "")
                      .split(/\s+/)[0];
                    return (
                      <button
                        key={nvKey}
                        onClick={() => handleVoiceChange(nvKey)}
                        title={`${nv.name} — không cần mạng`}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                          voice === nvKey
                            ? "bg-emerald-600 border-emerald-600 text-white"
                            : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-400"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* Sleep timer */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400 dark:text-gray-500 font-medium w-16 shrink-0">
              Hẹn giờ
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
              {sleepRemaining !== null ? fmtTime(sleepRemaining) : "Tắt"}
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
              <div className="flex gap-1.5">
                <input
                  type="number"
                  min="1"
                  max="300"
                  placeholder="Số phút..."
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
    </div>
  );
}
