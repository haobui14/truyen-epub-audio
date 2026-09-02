import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativeOfflineRepository,
  type OfflineChapterRecord,
} from "./offlineRepository";

describe("NativeOfflineRepository", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "OfflineBridge");
  });

  it("reads chapter text and IDs from the native bridge", async () => {
    const chapter: OfflineChapterRecord = {
      id: "chapter-2",
      book_id: "book-1",
      text_content: "Nội dung",
      cached_at: 123,
      bytes: 9,
    };
    Object.defineProperty(window, "OfflineBridge", {
      configurable: true,
      value: {
        getChapter: vi.fn(() => JSON.stringify(chapter)),
        listChapterIds: vi.fn(() => JSON.stringify(["chapter-1", "chapter-2"])),
      },
    });

    const repository = new NativeOfflineRepository();

    await expect(repository.getChapter("book-1", "chapter-2")).resolves.toEqual(
      chapter,
    );
    await expect(repository.listChapterIds("book-1")).resolves.toEqual([
      "chapter-1",
      "chapter-2",
    ]);
  });

  it("returns null when a chapter is not stored", async () => {
    Object.defineProperty(window, "OfflineBridge", {
      configurable: true,
      value: {
        getChapter: vi.fn(() => ""),
      },
    });

    await expect(
      new NativeOfflineRepository().getChapter("book-1", "missing"),
    ).resolves.toBeNull();
  });
});
