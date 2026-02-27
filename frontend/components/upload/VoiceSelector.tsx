import { VOICES } from "@/types";

interface VoiceSelectorProps {
  value: string;
  onChange: (v: string) => void;
}

export function VoiceSelector({ value, onChange }: VoiceSelectorProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
        Giọng đọc
      </label>
      <div className="grid grid-cols-2 gap-3">
        {VOICES.map((v) => (
          <label
            key={v.value}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 cursor-pointer transition-all ${
              value === v.value
                ? "border-indigo-600 bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 shadow-sm"
                : "border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500 text-gray-700 dark:text-gray-300"
            }`}
          >
            <input
              type="radio"
              name="voice"
              value={v.value}
              checked={value === v.value}
              onChange={() => onChange(v.value)}
              className="hidden"
            />
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              value === v.value
                ? "bg-indigo-600 text-white"
                : "bg-gray-100 dark:bg-gray-700 text-gray-400"
            }`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <span className="text-sm font-medium">{v.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
