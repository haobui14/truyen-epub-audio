"use client";
import { useRef, useState } from "react";
import { ACCEPTED_UPLOAD_EXTS, MAX_UPLOAD_MB } from "@/lib/api";

interface UploadZoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

export function UploadZone({ onFile, disabled }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = (file: File) => {
    const name = file.name.toLowerCase();
    if (!ACCEPTED_UPLOAD_EXTS.some((ext) => name.endsWith(ext))) {
      alert(`Vui lòng chọn file ${ACCEPTED_UPLOAD_EXTS.join(", ")}`);
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
      className={`relative border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-[border-color,background-color,transform] duration-200 ${
        isDragging
          ? "border-accent bg-accent/80 dark:bg-accent/50 scale-[1.01]"
          : "border-hairline dark:border-hairline hover:border-accent/40 hover:bg-ink dark:hover:bg-raised/50"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".epub,.pdf,.txt,.prc,.mobi"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
      <div className="inline-flex items-center justify-center w-14 h-14 bg-raised dark:bg-raised-hi rounded-2xl mb-4">
        <svg
          className="w-7 h-7 text-text-mute"
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
      <p className="text-text-dim dark:text-text-faint font-medium mb-1">
        Kéo thả file vào đây
      </p>
      <p className="text-sm text-text-mute dark:text-text-mute">
        EPUB · PDF · TXT · PRC · MOBI &nbsp;·&nbsp; tối đa {MAX_UPLOAD_MB}MB
      </p>
    </div>
  );
}
