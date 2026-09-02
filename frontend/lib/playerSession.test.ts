import { describe, expect, it } from "vitest";
import { buildPlayerSessionSnapshot } from "./playerSession";

const idlePlayer = {
  progress: 0,
  chunkIndex: 0,
  totalChunks: 0,
  isPlaying: false,
  isBuffering: false,
};

describe("buildPlayerSessionSnapshot", () => {
  it("keeps a restored native session active without a React track", () => {
    const snapshot = buildPlayerSessionSnapshot({
      nativeEnabled: true,
      nativeSession: {
        bookId: "book-1",
        bookTitle: "Truyện",
        coverUrl: "cover.jpg",
        chapterId: "chapter-2",
        title: "Chương 2",
        chunkIndex: 4,
        totalChunks: 10,
        playing: true,
      },
      track: null,
      player: idlePlayer,
    });
    expect(snapshot).toMatchObject({
      active: true,
      source: "native-restored",
      progress: 0.4,
      chapterId: "chapter-2",
    });
  });

  it("returns an inactive stable shape when no session exists", () => {
    const snapshot = buildPlayerSessionSnapshot({
      nativeEnabled: false,
      nativeSession: null,
      track: null,
      player: idlePlayer,
    });
    expect(snapshot.active).toBe(false);
    expect(snapshot.source).toBe("none");
  });
});

