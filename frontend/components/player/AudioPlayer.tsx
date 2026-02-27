"use client";
import Image from "next/image";
import type { Chapter, Book } from "@/types";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";
import { ProgressBar } from "./ProgressBar";
import { SpeedControl } from "./SpeedControl";
import { Spinner } from "@/components/ui/Spinner";

interface AudioPlayerProps {
  chapter: Chapter;
  book: Book;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}

export function AudioPlayer({ chapter, book, onPrev, onNext }: AudioPlayerProps) {
  const audioUrl = chapter.audio?.public_url ?? null;
  const { isPlaying, isLoading, currentTime, duration, playbackRate, toggle, seek, setSpeed } =
    useAudioPlayer(chapter.id, audioUrl);

  return (
    <div className="flex flex-col items-center gap-6 p-6 max-w-lg mx-auto">
      {/* Cover art */}
      <div className="w-48 h-48 rounded-2xl overflow-hidden bg-indigo-100 shadow-lg shrink-0">
        {book.cover_url ? (
          <Image src={book.cover_url} alt={book.title} width={192} height={192} className="object-cover w-full h-full" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-indigo-300">
            <svg className="w-20 h-20" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
          </div>
        )}
      </div>

      {/* Chapter info */}
      <div className="text-center">
        <p className="text-xs text-indigo-500 font-medium uppercase tracking-wide mb-1">
          {book.title}
        </p>
        <h2 className="text-lg font-bold text-gray-900">{chapter.title}</h2>
        <p className="text-xs text-gray-400 mt-1">
          Chương {chapter.chapter_index + 1} · Giọng {book.voice.includes("HoaiMy") ? "HoaiMy (Nữ)" : "NamMinh (Nam)"}
        </p>
      </div>

      {/* Progress bar */}
      <div className="w-full">
        <ProgressBar currentTime={currentTime} duration={duration} onSeek={seek} />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-6">
        <button
          onClick={onPrev ?? undefined}
          disabled={!onPrev}
          className="p-2 text-gray-400 hover:text-gray-700 disabled:opacity-30 transition-colors"
          title="Chương trước"
        >
          <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
          </svg>
        </button>

        <button
          onClick={toggle}
          disabled={isLoading || !audioUrl}
          className="w-16 h-16 bg-indigo-600 text-white rounded-full flex items-center justify-center hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-lg"
          title={isPlaying ? "Tạm dừng" : "Phát"}
        >
          {isLoading ? (
            <Spinner className="w-6 h-6" />
          ) : isPlaying ? (
            <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg className="w-7 h-7 ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <button
          onClick={onNext ?? undefined}
          disabled={!onNext}
          className="p-2 text-gray-400 hover:text-gray-700 disabled:opacity-30 transition-colors"
          title="Chương tiếp"
        >
          <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      </div>

      {/* Speed control */}
      <SpeedControl value={playbackRate} onChange={setSpeed} />
    </div>
  );
}
