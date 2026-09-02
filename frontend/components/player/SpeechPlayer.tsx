"use client";
import { useState, useEffect } from "react";
import Image from "next/image";
import { usePlayerContext } from "@/context/PlayerContext";
import { Spinner } from "@/components/ui/Spinner";
import {
  useNativeTTSAvailable,
  useNativeTTSVoices,
} from "@/hooks/useNativeTTSPlayer";
import { useBrowserTTSVoices } from "@/hooks/useBrowserTTSPlayer";
import { getTtsBridge } from "@/lib/backgroundLock";
import { Sheet } from "@/components/ui/Sheet";

const SLEEP_PRESETS = [15, 30, 45, 60] as const;
const SPEED_PRESETS = [0.8, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0] as const;
const BATTERY_HINT_DISMISSED_KEY = "battery-opt-hint-dismissed";

const BACKEND_VOICES = [
  { value: "vi-VN-HoaiMyNeural", label: "HoaiMy" },
  { value: "vi-VN-NamMinhNeural", label: "NamMinh" },
  { value: "gtts", label: "gTTS" },
] as const;

const VOICE_LABELS: Record<string, string> = {
  "vi-VN-HoaiMyNeural": "HoaiMy · vi-VN",
  "vi-VN-NamMinhNeural": "NamMinh · vi-VN",
  gtts: "gTTS · vi-VN",
  "native:vi-VN-default": "Hệ thống · vi-VN",
};

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

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
    pitch,
    toggle,
    changeRate,
    changePitch,
    restartChunk,
    seekChunk,
    cacheStatuses,
    nativeTtsError,
    clearNativeTtsError,
    sleepRemaining,
    setSleepTimer,
    cancelSleepTimer,
    sleepAtChapterEnd,
    setSleepChapterEnd,
  } = usePlayerContext();

  const isNative = useNativeTTSAvailable();
  const nativeVoices = useNativeTTSVoices();
  // Device voices via the Web Speech API — empty on the native APK and on
  // machines with no Vietnamese voice installed (section hides itself).
  const browserVoices = useBrowserTTSVoices();
  const [openPanel, setOpenPanel] = useState<
    null | "speed" | "voice" | "sleep"
  >(null);
  const [customMinutes, setCustomMinutes] = useState("");
  const [showNotificationPermission, setShowNotificationPermission] =
    useState(false);

  // One-time battery-optimization hint: without the Doze exemption,
  // aggressive OEMs (Samsung/Xiaomi/...) kill the TTS foreground service
  // during long screen-off sessions.
  const [showBatteryHint, setShowBatteryHint] = useState(false);
  useEffect(() => {
    if (!isNative) return;
    const check = () => {
      const bridge = getTtsBridge();
      if (typeof bridge?.isIgnoringBatteryOptimizations !== "function") return;
      if (localStorage.getItem(BATTERY_HINT_DISMISSED_KEY) === "1") {
        setShowBatteryHint(false);
        return;
      }
      try {
        setShowBatteryHint(!bridge.isIgnoringBatteryOptimizations());
      } catch {
        /* ignore */
      }
    };
    check();
    // Re-check when the user returns from the system dialog / settings.
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isNative]);

  if (!track) return null;

  const { chapter, book, isLoadingText, onPrev, onNext } = track;

  const downloadingCount = Object.values(cacheStatuses).filter(
    (s) => s === "downloading",
  ).length;

  const ready = !isLoadingText && (mode === "full" || !!track.text);
  const progressPct = Math.max(0, Math.min(100, Math.round(progress * 100)));

  const chunkDotCount = 20;
  const filledDots =
    totalChunks > 0
      ? Math.round((chunkIndex / Math.max(1, totalChunks)) * chunkDotCount)
      : Math.round(progress * chunkDotCount);

  function handleVoiceChange(newVoice: string) {
    if (newVoice === voice) {
      setOpenPanel(null);
      return;
    }
    const engineOf = (v: string) =>
      v.startsWith("native:")
        ? "native"
        : v.startsWith("browser:")
          ? "browser"
          : "backend";
    const switchingEngine = engineOf(newVoice) !== engineOf(voice);
    if (switchingEngine && isPlaying) toggle();
    // Same-engine native/browser switches restart inside their own hook's
    // voice effect, which applies the new voice BEFORE re-speaking;
    // restarting here would replay the chunk with the old voice.
    else if (engineOf(newVoice) === "backend") restartChunk();
    setVoice(newVoice);
    setOpenPanel(null);
  }

  function handleSetTimer(mins: number) {
    setSleepTimer(mins);
    setOpenPanel(null);
    setCustomMinutes("");
  }

  function handleCustomTimer() {
    const mins = parseFloat(customMinutes);
    if (!isNaN(mins) && mins > 0) handleSetTimer(mins);
  }

  function handleTransportToggle() {
    const bridge = getTtsBridge();
    if (
      isNative &&
      !isPlaying &&
      bridge?.getNotificationPermissionStatus?.() === "denied" &&
      localStorage.getItem("notification-permission-context-shown") !== "1"
    ) {
      setShowNotificationPermission(true);
      return;
    }
    toggle();
  }

  const voiceLabel = VOICE_LABELS[voice] ?? voice.replace(/^native:/, "");
  const nativeVoiceOpt = nativeVoices.find((v) => v.value === voice);
  const browserVoiceOpt = browserVoices.find((v) => v.value === voice);
  const voiceBadge = voice.startsWith("native:")
    ? voice === "native:vi-VN-default" || !nativeVoiceOpt
      ? "GIỌNG HỆ THỐNG · VI-VN"
      : `${nativeVoiceOpt.label.toUpperCase()} · VI-VN`
    : voice.startsWith("browser:")
      ? `${(browserVoiceOpt?.label ?? "Giọng thiết bị").toUpperCase()} · VI-VN`
      : voiceLabel.toUpperCase();
  const supportsChapterEndSleep =
    isNative && typeof getTtsBridge()?.setSleepAtChapterEnd === "function";

  return (
    <div className="w-full">
      {/* Hero halo + cover with breathing glow + 讀 seal.
          Cover height capped against the viewport so the play button stays
          above the fold on Android phones (412×892 ≈ ~700px usable). */}
      <div
        className="relative -mx-4 sm:-mx-6 px-4 sm:px-6 pt-2 pb-1"
        style={{
          background:
            "radial-gradient(140% 50% at 50% -10%, oklch(0.30 0.07 165 / 0.40) 0%, transparent 55%)",
        }}
      >
        <div className="flex justify-center pt-1 pb-2">
          <div
            className="relative aspect-[4/5]"
            style={{
              width: "min(180px, 32vh)",
            }}
          >
            <div className="image-outline h-full w-full overflow-hidden rounded-lg bg-raised shadow-[0_30px_60px_rgba(0,0,0,0.55)]">
              {book.cover_url ? (
                <Image
                  src={book.cover_url}
                  alt={book.title}
                  fill
                  sizes="220px"
                  className="object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-text-faint">
                  <svg
                    className="w-12 h-12"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                  </svg>
                </div>
              )}
            </div>
            <div
              className="absolute -top-2.5 -right-2.5 w-10 h-10 rounded-sm flex items-center justify-center bg-vermillion text-text -rotate-3"
              style={{
                boxShadow:
                  "inset 0 0 0 2px oklch(0.55 0.18 27), 0 4px 14px rgba(0,0,0,0.5)",
              }}
              aria-hidden="true"
            >
              <span className="font-display text-xl leading-none font-semibold">
                讀
              </span>
            </div>
            <div
              className={`absolute -inset-2.5 rounded-xl border border-accent pointer-events-none ${
                isPlaying ? "animate-breathe" : ""
              }`}
              style={{ opacity: 0.25 }}
            />
          </div>
        </div>
      </div>

      {/* Title + meta */}
      <div className="px-1 sm:px-2 pt-1 pb-2">
        <h2 className="font-display text-xl sm:text-2xl text-text leading-tight line-clamp-2">
          {chapter.title}
        </h2>
        <div className="flex items-center gap-2 mt-1 text-xs sm:text-sm text-text-mute min-w-0">
          <span className="truncate">{book.title}</span>
          <span className="text-text-faint">·</span>
          <span className="font-mono text-[9px] sm:text-[10px] tracking-widest text-accent shrink-0">
            {voiceBadge}
          </span>
        </div>
      </div>

      {nativeTtsError && (
        <div className="flex items-start gap-2 px-3 py-2.5 mb-3 rounded-md bg-vermillion/10 border border-vermillion/30" role="alert" aria-live="assertive">
          <svg
            className="w-4 h-4 text-vermillion shrink-0 mt-0.5"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
              clipRule="evenodd"
            />
          </svg>
          <div className="min-w-0">
            <p className="text-xs text-vermillion leading-snug">
              {nativeTtsError}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
              {typeof (window as unknown as { TtsBridge?: { openTtsSettings?: () => void } })
                .TtsBridge?.openTtsSettings === "function" && (
                <button
                  type="button"
                  onClick={() =>
                    (window as unknown as { TtsBridge: { openTtsSettings: () => void } })
                      .TtsBridge.openTtsSettings()
                  }
                  className="min-h-11 text-xs font-medium text-vermillion underline underline-offset-2 active:opacity-60"
                >
                  Mở cài đặt giọng đọc
                </button>
              )}
              {typeof (window as unknown as { TtsBridge?: { retryTts?: () => void } })
                .TtsBridge?.retryTts === "function" && (
                <button
                  type="button"
                  onClick={() => {
                    clearNativeTtsError();
                    (window as unknown as { TtsBridge: { retryTts: () => void } })
                      .TtsBridge.retryTts();
                  }}
                  className="min-h-11 text-xs font-medium text-vermillion underline underline-offset-2 active:opacity-60"
                >
                  Thử lại
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showBatteryHint && !nativeTtsError && (
        <div className="flex items-start gap-2 px-3 py-2.5 mb-3 rounded-md bg-gold/10 border border-gold/30">
          <svg
            className="w-4 h-4 text-gold shrink-0 mt-0.5"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M11.983 1.907a.75.75 0 00-1.292-.657l-8.5 9.5A.75.75 0 002.75 12h4.116l-.849 6.093a.75.75 0 001.292.657l8.5-9.5A.75.75 0 0015.25 8h-4.116l.849-6.093z" />
          </svg>
          <div className="min-w-0">
            <p className="text-xs text-gold leading-snug">
              Máy có thể tự ngắt phát khi khoá màn hình lâu. Cho phép ứng dụng
              bỏ qua tối ưu hoá pin để nghe không gián đoạn.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
              <button
                type="button"
                onClick={() => {
                  try {
                    getTtsBridge()?.requestIgnoreBatteryOptimizations?.();
                  } catch {
                    /* ignore */
                  }
                }}
                className="min-h-11 text-xs font-medium text-gold underline underline-offset-2 active:opacity-60"
              >
                Cho phép
              </button>
              <button
                type="button"
                onClick={() => {
                  localStorage.setItem(BATTERY_HINT_DISMISSED_KEY, "1");
                  setShowBatteryHint(false);
                }}
                className="min-h-11 text-xs font-medium text-text-mute underline underline-offset-2 active:opacity-60"
              >
                Ẩn
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 20-segment chunk-dot progress */}
      <div className="pb-1 pt-0.5">
        <div className="relative flex h-11 items-center">
          <input
            type="range"
            min={0}
            max={Math.max(1, totalChunks - (mode === "full" ? 0 : 1))}
            step={mode === "full" ? Math.max(1, totalChunks / 20) : 1}
            value={Math.min(chunkIndex, Math.max(1, totalChunks))}
            onChange={(event) => {
              const target = Number(event.target.value);
              if (mode === "full") {
                const targetProgress = totalChunks > 0 ? target / totalChunks : 0;
                seekChunk((targetProgress - progress) * 20);
              } else {
                seekChunk(target - chunkIndex);
              }
            }}
            disabled={!ready || totalChunks <= 0}
            aria-label="Vị trí phát"
            aria-valuetext={
              mode === "full"
                ? `${fmtTime(chunkIndex)} đã phát, còn ${fmtTime(Math.max(0, totalChunks - chunkIndex))}`
                : `Đoạn ${Math.min(chunkIndex + 1, totalChunks)} trên ${totalChunks}, còn ${Math.max(0, totalChunks - chunkIndex - 1)} đoạn`
            }
            className="absolute inset-0 z-10 h-11 w-full cursor-pointer opacity-0 disabled:cursor-default"
          />
          <span className="pointer-events-none flex h-1 w-full gap-[3px]" aria-hidden="true">
            {Array.from({ length: chunkDotCount }).map((_, i) => {
              const filled = i < filledDots;
              const current = i === filledDots;
              return (
                <span
                  key={i}
                  className={`flex-1 rounded-[1px] transition-colors ${
                    filled
                      ? "bg-accent"
                      : current
                        ? "bg-accent/70"
                        : "bg-hairline"
                  }`}
                />
              );
            })}
          </span>
        </div>
        <div className="flex justify-between items-center mt-1.5 font-mono text-[10px] tracking-widest tabular-nums text-text-faint">
          {totalChunks > 0 ? (
            mode === "full" ? (
              <>
                <span>{fmtTime(chunkIndex)}</span>
                <span>{progressPct}%</span>
                <span>−{fmtTime(Math.max(0, totalChunks - chunkIndex))}</span>
              </>
            ) : (
              <>
                <span>
                  {chunkIndex + 1} / {totalChunks} đoạn
                </span>
                <span>{progressPct}%</span>
                <span>−{Math.max(0, totalChunks - chunkIndex - 1)}</span>
              </>
            )
          ) : (
            <span className="font-sans normal-case tracking-normal italic text-text-faint">
              {isLoadingText
                ? "Đang tải..."
                : !track.text && mode !== "full"
                  ? "Không có nội dung"
                  : "Sẵn sàng"}
            </span>
          )}
        </div>
      </div>

      {/* Status line — only takes up space when there's something to say */}
      <div
        className="flex items-center justify-center font-mono text-[10px] uppercase tracking-widest empty:hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {isBuffering ? (
          isOffline ? (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
              <span className="text-gold">Mất kết nối, đang chờ...</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span className="text-accent">Đang tải âm thanh...</span>
            </span>
          )
        ) : downloadingCount > 0 ? (
          <span className="flex items-center gap-1.5 text-text-faint">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent/60 animate-pulse" />
            Đang tải sẵn {downloadingCount} chương...
          </span>
        ) : null}
      </div>

      {/* Transport row — 5 buttons centred */}
      <div className="flex items-center justify-between px-2 pt-2 pb-0">
        <button
          onClick={onPrev ?? undefined}
          disabled={!onPrev}
          className="flex min-h-12 min-w-12 items-center justify-center p-3 text-text transition-[color,opacity,transform] hover:text-accent active:scale-[0.96] disabled:text-text-faint disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none"
          title="Chương trước"
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19 6l-9 6 9 6V6zM6 6h2v12H6V6z" />
          </svg>
        </button>
        <button
          onClick={() => seekChunk(-1)}
          disabled={!ready || totalChunks === 0}
          className="flex min-h-12 min-w-12 items-center justify-center p-3 text-text-mute transition-[color,opacity,transform] hover:text-accent active:scale-[0.96] disabled:text-text-faint disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none"
          title="Lùi đoạn"
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M11 17l-5-5 5-5v3h7v4h-7v3z" />
          </svg>
        </button>
        <button
          onClick={handleTransportToggle}
          disabled={!ready || Boolean(nativeTtsError)}
          className="relative flex size-[76px] items-center justify-center rounded-full bg-accent text-ink shadow-[0_0_0_6px_oklch(0.74_0.11_165/0.12),0_0_40px_var(--color-accent-glow)] transition-[background-color,opacity,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-accent-dim active:scale-[0.96] disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none"
          aria-label={isPlaying ? "Tạm dừng" : "Phát"}
          title={isPlaying ? "Tạm dừng" : "Phát"}
        >
          {isLoadingText || isBuffering ? (
            <Spinner className="w-7 h-7" />
          ) : (
            <span className="relative block size-[26px]" aria-hidden="true">
              <svg
                className={`absolute inset-0 size-[26px] transition-[opacity,transform,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${isPlaying ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]"}`}
                fill="currentColor"
                viewBox="0 0 14 14"
              >
                <rect x="2" y="1" width="3.5" height="12" rx="0.5" />
                <rect x="8.5" y="1" width="3.5" height="12" rx="0.5" />
              </svg>
              <svg
                className={`absolute inset-0 size-[26px] pl-0.5 transition-[opacity,transform,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${isPlaying ? "scale-[0.25] opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-0"}`}
                fill="currentColor"
                viewBox="0 0 14 14"
              >
                <path d="M3 1l10 6-10 6V1z" />
              </svg>
            </span>
          )}
        </button>
        <button
          onClick={() => seekChunk(1)}
          disabled={!ready || totalChunks === 0}
          className="flex min-h-12 min-w-12 items-center justify-center p-3 text-text-mute transition-[color,opacity,transform] hover:text-accent active:scale-[0.96] disabled:text-text-faint disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none"
          title="Tiến đoạn"
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M13 7l5 5-5 5v-3H6v-4h7V7z" />
          </svg>
        </button>
        <button
          onClick={onNext ?? undefined}
          disabled={!onNext}
          className="flex min-h-12 min-w-12 items-center justify-center p-3 text-text transition-[color,opacity,transform] hover:text-accent active:scale-[0.96] disabled:text-text-faint disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none"
          title="Chương tiếp"
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 6l9 6-9 6V6zm11 0h2v12h-2V6z" />
          </svg>
        </button>
      </div>

      {/* Chip strip */}
      <div className="flex gap-2 pt-3 pb-1">
        <Chip
          label={`${rate.toFixed(2).replace(/\.?0+$/, "")}×`}
          sub="Tốc độ"
          mono
          active={openPanel === "speed"}
          onClick={() => setOpenPanel(openPanel === "speed" ? null : "speed")}
        />
        <Chip
          label={
            voice.startsWith("native:")
              ? voice === "native:vi-VN-default" || !nativeVoiceOpt
                ? "Hệ thống"
                : nativeVoiceOpt.label.split(" · ")[0]
              : voice.startsWith("browser:")
                ? (browserVoiceOpt?.label ?? "Thiết bị").split(" · ")[0]
                : voiceLabel.split(" ")[0]
          }
          sub="Giọng đọc"
          active={openPanel === "voice"}
          onClick={() => setOpenPanel(openPanel === "voice" ? null : "voice")}
        />
        <Chip
          label={
            sleepAtChapterEnd
              ? "Hết chương"
              : sleepRemaining !== null
                ? fmtTime(sleepRemaining)
                : "Tắt"
          }
          sub="Hẹn giờ"
          mono
          active={
            sleepRemaining !== null || sleepAtChapterEnd || openPanel === "sleep"
          }
          onClick={() => {
            if (sleepRemaining !== null || sleepAtChapterEnd) {
              cancelSleepTimer();
              setOpenPanel(null);
            } else {
              setOpenPanel(openPanel === "sleep" ? null : "sleep");
            }
          }}
        />
      </div>

      {/* Chip panels */}
      {openPanel === "speed" && (
        <Sheet open title="Tốc độ và tông" onClose={() => setOpenPanel(null)}>
          <p className="font-mono text-[10px] tracking-widest uppercase text-text-faint mb-2">
            Tốc độ phát ·{" "}
            <span className="text-accent">
              {rate.toFixed(2).replace(/\.?0+$/, "")}×
            </span>
          </p>
          <div className="grid grid-cols-7 gap-1.5 mb-3">
            {SPEED_PRESETS.map((s) => (
              <button
                key={s}
                onClick={() => {
                  changeRate(s);
                  setOpenPanel(null);
                }}
                className={`flex min-h-11 items-center justify-center rounded-lg border text-xs font-medium transition-[color,background-color,border-color,transform] active:scale-[0.96] touch-manipulation ${
                  Math.abs(rate - s) < 0.001
                    ? "bg-accent border-accent text-ink"
                    : "border-hairline text-text-mute hover:border-accent/40 hover:text-accent"
                }`}
              >
                {s.toFixed(2).replace(/\.?0+$/, "")}×
              </button>
            ))}
          </div>
          {voice.startsWith("native:") && (
            <div className="pt-2 border-t border-hairline-soft">
              <p className="font-mono text-[10px] tracking-widest uppercase text-text-faint mb-2">
                Tông ·{" "}
                <span className="text-accent">
                  {pitch.toFixed(2).replace(/\.?0+$/, "")}×
                </span>
              </p>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={pitch}
                onChange={(e) => changePitch(parseFloat(e.target.value))}
                className="h-11 w-full cursor-pointer appearance-none rounded-full"
                style={{
                  background: `linear-gradient(to right, var(--color-accent) ${
                    ((pitch - 0.5) / 1.5) * 100
                  }%, var(--color-raised-hi) ${((pitch - 0.5) / 1.5) * 100}%)`,
                }}
              />
            </div>
          )}
        </Sheet>
      )}

      {openPanel === "voice" && (
        <Sheet open title="Giọng đọc" onClose={() => setOpenPanel(null)}>
          <p className="font-mono text-[10px] tracking-widest uppercase text-text-faint mb-2">
            Giọng đọc
          </p>
          <div className="flex gap-1.5 flex-wrap">
            {!isNative &&
              BACKEND_VOICES.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleVoiceChange(opt.value)}
                  className={`min-h-11 rounded-lg border px-3 py-1.5 text-xs font-medium transition-[color,background-color,border-color,transform] active:scale-[0.96] ${
                    voice === opt.value
                      ? "bg-accent border-accent text-ink"
                      : "border-hairline text-text-mute hover:border-accent/40 hover:text-accent"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            {isNative &&
              nativeVoices.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleVoiceChange(opt.value)}
                  className={`min-h-11 rounded-lg border px-3 py-1.5 text-xs font-medium transition-[color,background-color,border-color,transform] active:scale-[0.96] touch-manipulation ${
                    voice === opt.value ||
                    (opt.value === "native:vi-VN-default" &&
                      voice.startsWith("native:") &&
                      !nativeVoiceOpt)
                      ? "bg-accent border-accent text-ink"
                      : "border-hairline text-text-mute hover:border-accent/40 hover:text-accent"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
          </div>
          {!isNative && browserVoices.length > 0 && (
            <>
              <p className="font-mono text-[10px] tracking-widest uppercase text-text-faint mt-3 mb-2">
                Giọng thiết bị · không dùng máy chủ
              </p>
              <div className="flex gap-1.5 flex-wrap">
                {browserVoices.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleVoiceChange(opt.value)}
                    className={`min-h-11 rounded-lg border px-3 py-1.5 text-xs font-medium transition-[color,background-color,border-color,transform] active:scale-[0.96] ${
                      voice === opt.value
                        ? "bg-accent border-accent text-ink"
                        : "border-hairline text-text-mute hover:border-accent/40 hover:text-accent"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </Sheet>
      )}

      {openPanel === "sleep" && (
        <Sheet open title="Hẹn giờ tắt" onClose={() => setOpenPanel(null)}>
          <p className="font-mono text-[10px] tracking-widest uppercase text-text-faint mb-2">
            Hẹn giờ tắt
          </p>
          {supportsChapterEndSleep && (
            <button
              onClick={() => {
                setSleepChapterEnd();
                setOpenPanel(null);
                setCustomMinutes("");
              }}
              className="mb-2 min-h-11 w-full rounded-lg border border-hairline py-2 text-xs font-medium text-text-mute transition-[color,border-color,transform] hover:border-accent/40 hover:text-accent active:scale-[0.96] touch-manipulation"
            >
              Khi hết chương này
            </button>
          )}
          <div className="grid grid-cols-4 gap-1.5 mb-2">
            {SLEEP_PRESETS.map((mins) => (
              <button
                key={mins}
                onClick={() => handleSetTimer(mins)}
                className="min-h-11 rounded-lg border border-hairline py-1.5 text-xs font-medium text-text-mute transition-[color,border-color,transform] hover:border-accent/40 hover:text-accent active:scale-[0.96]"
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
              className="min-h-11 flex-1 rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs text-text placeholder-text-faint focus:border-accent focus:outline-none"
            />
            <button
              onClick={handleCustomTimer}
              disabled={
                !customMinutes ||
                isNaN(parseFloat(customMinutes)) ||
                parseFloat(customMinutes) <= 0
              }
              className="min-h-11 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink transition-[background-color,opacity,transform] hover:bg-accent-dim active:scale-[0.96] disabled:opacity-40"
            >
              Đặt
            </button>
          </div>
        </Sheet>
      )}

      <Sheet
        open={showNotificationPermission}
        onClose={() => setShowNotificationPermission(false)}
        title="Điều khiển khi khóa màn hình"
        description="Thông báo phát nhạc là tùy chọn"
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowNotificationPermission(false)}
              className="min-h-11 flex-1 rounded-xl border border-hairline px-4 text-sm font-semibold text-text-mute transition-[background-color,transform] hover:bg-raised active:scale-[0.96]"
            >
              Để sau
            </button>
            <button
              type="button"
              onClick={() => {
                localStorage.setItem("notification-permission-context-shown", "1");
                getTtsBridge()?.requestNotificationPermission?.();
                setShowNotificationPermission(false);
                toggle();
              }}
              className="min-h-11 flex-1 rounded-xl bg-accent px-4 text-sm font-semibold text-ink transition-[background-color,transform] hover:bg-accent-dim active:scale-[0.96]"
            >
              Tiếp tục
            </button>
          </div>
        }
      >
        <p className="text-sm leading-relaxed text-text-mute">
          Cho phép thông báo để tạm dừng, chuyển chương và xem trạng thái nghe
          từ màn hình khóa. Nếu từ chối, bạn vẫn có thể đọc và nghe khi ứng dụng
          đang mở.
        </p>
      </Sheet>
    </div>
  );
}

interface ChipProps {
  label: string;
  sub: string;
  mono?: boolean;
  active?: boolean;
  onClick?: () => void;
}

function Chip({ label, sub, mono, active, onClick }: ChipProps) {
  return (
    <button
      onClick={onClick}
      className={`flex min-h-11 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border px-1 py-2 transition-[color,background-color,border-color,transform] active:scale-[0.96] ${
        active
          ? "bg-accent/15 border-accent/40"
          : "bg-raised border-hairline hover:border-accent/30"
      }`}
    >
      <span
        className={`text-[13px] font-semibold text-text ${
          mono ? "font-mono tabular-nums" : "font-sans"
        }`}
      >
        {label}
      </span>
      <span className="font-mono text-[9px] tracking-widest uppercase text-text-mute">
        {sub}
      </span>
    </button>
  );
}
