"use client";

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface ProgressBarProps {
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
}

export function ProgressBar({ currentTime, duration, onSeek }: ProgressBarProps) {
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="w-full">
      <div
        className="group relative h-2 bg-gray-200 rounded-full cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          onSeek(ratio * duration);
        }}
      >
        <div
          className="h-full bg-indigo-600 rounded-full transition-all"
          style={{ width: `${progress}%` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-indigo-600 rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ left: `calc(${progress}% - 8px)` }}
        />
      </div>
      <div className="flex justify-between mt-1 text-xs text-gray-400">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}
