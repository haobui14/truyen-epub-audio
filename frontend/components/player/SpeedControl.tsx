"use client";
import { SPEED_PRESETS } from "@/types";

interface SpeedControlProps {
  value: number;
  onChange: (rate: number) => void;
}

export function SpeedControl({ value, onChange }: SpeedControlProps) {
  return (
    <div className="flex items-center gap-1">
      {SPEED_PRESETS.map((speed) => (
        <button
          key={speed}
          onClick={() => onChange(speed)}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
            value === speed
              ? "bg-indigo-600 text-white shadow-sm"
              : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
          }`}
        >
          {speed}x
        </button>
      ))}
    </div>
  );
}
