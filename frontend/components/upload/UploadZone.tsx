"use client";
import { useRef, useState } from "react";

interface UploadZoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

export function UploadZone({ onFile, disabled }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = (file: File) => {
    if (!file.name.toLowerCase().endsWith(".epub")) {
      alert("Vui lòng chọn file .epub");
      return;
    }
    onFile(file);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (disabled) return;
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      className={`relative border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all duration-200 ${
        isDragging
          ? "border-indigo-500 bg-indigo-50/80 dark:bg-indigo-950/50 scale-[1.01]"
          : "border-gray-300 dark:border-gray-600 hover:border-indigo-400 hover:bg-gray-50 dark:hover:bg-gray-800/50"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".epub"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
      <div className="inline-flex items-center justify-center w-14 h-14 bg-gray-100 dark:bg-gray-700 rounded-2xl mb-4">
        <svg
          className="w-7 h-7 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>
      </div>
      <p className="text-gray-600 dark:text-gray-300 font-medium mb-1">
        Kéo thả file EPUB vào đây
      </p>
      <p className="text-sm text-gray-400 dark:text-gray-500">hoặc nhấn để chọn file (tối đa 50MB)</p>
    </div>
  );
}
