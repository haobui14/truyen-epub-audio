import type {
  PlayerSessionSnapshot,
  PlayerTrack,
} from "@/context/PlayerContext";

interface NativeSessionOverride {
  bookId: string;
  bookTitle: string;
  coverUrl: string;
  chapterId: string;
  title: string;
  chunkIndex: number;
  totalChunks: number;
  playing: boolean;
}

interface PlayerStateForSnapshot {
  progress: number;
  chunkIndex: number;
  totalChunks: number;
  isPlaying: boolean;
  isBuffering: boolean;
}

export function buildPlayerSessionSnapshot({
  nativeEnabled,
  nativeSession,
  track,
  player,
}: {
  nativeEnabled: boolean;
  nativeSession: NativeSessionOverride | null;
  track: PlayerTrack | null;
  player: PlayerStateForSnapshot;
}): PlayerSessionSnapshot {
  if (nativeEnabled && nativeSession?.bookId) {
    const total = Math.max(0, nativeSession.totalChunks);
    const current = Math.max(0, nativeSession.chunkIndex);
    return {
      active: true,
      source: "native-restored",
      bookId: nativeSession.bookId,
      bookTitle: nativeSession.bookTitle,
      coverUrl: nativeSession.coverUrl || null,
      chapterId: nativeSession.chapterId,
      chapterTitle: nativeSession.title,
      chunkIndex: current,
      totalChunks: total,
      progress: total > 0 ? current / total : 0,
      isPlaying: nativeSession.playing,
      isBuffering: player.isBuffering,
    };
  }

  if (track) {
    return {
      active: true,
      source: "track",
      bookId: track.bookId,
      bookTitle: track.book.title,
      coverUrl: track.book.cover_url || null,
      chapterId: track.chapterId,
      chapterTitle: track.chapter.title,
      chunkIndex: Math.max(0, player.chunkIndex),
      totalChunks: Math.max(0, player.totalChunks),
      progress: Math.max(0, Math.min(1, player.progress)),
      isPlaying: player.isPlaying,
      isBuffering: player.isBuffering,
    };
  }

  return {
    active: false,
    source: "none",
    bookId: "",
    bookTitle: "",
    coverUrl: null,
    chapterId: "",
    chapterTitle: "",
    chunkIndex: 0,
    totalChunks: 0,
    progress: 0,
    isPlaying: false,
    isBuffering: false,
  };
}

