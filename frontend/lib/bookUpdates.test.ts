import { describe, expect, it } from "vitest";
import type { Book } from "@/types";
import { getRecentlyUpdatedBooks } from "./bookUpdates";

function book(id: string, overrides: Partial<Book> = {}): Book {
  return {
    id,
    title: id,
    voice: "vi-VN-HoaiMyNeural",
    status: "ready",
    total_chapters: 10,
    created_at: "2026-10-06T21:28:29Z",
    genres: [],
    ...overrides,
  };
}

describe("getRecentlyUpdatedBooks", () => {
  it("excludes untouched old imports and new uploads without chapter additions", () => {
    const books = [
      book("old-import", { created_at: "2026-03-13T20:10:20Z", last_chapter_added_at: null }),
      book("new-upload"),
    ];
    expect(getRecentlyUpdatedBooks(books)).toEqual([]);
  });

  it("includes a real addition even within 24 hours of the initial upload", () => {
    const updated = book("same-day-addition", { last_chapter_added_at: "2026-10-06T21:40:24Z" });
    expect(getRecentlyUpdatedBooks([updated])).toEqual([updated]);
  });

  it("orders by chapter addition time rather than book upload time", () => {
    const books = [
      book("newer-upload", { last_chapter_added_at: "2026-10-06T21:40:24Z" }),
      book("older-upload", { created_at: "2026-03-13T20:10:20Z", last_chapter_added_at: "2026-10-09T12:00:00Z" }),
    ];
    expect(getRecentlyUpdatedBooks(books).map((item) => item.id)).toEqual(["older-upload", "newer-upload"]);
    expect(books.map((item) => item.id)).toEqual(["newer-upload", "older-upload"]);
  });

  it("excludes invalid timestamps and books whose chapters have been removed", () => {
    expect(getRecentlyUpdatedBooks([
      book("invalid", { last_chapter_added_at: "invalid" }),
      book("empty", { total_chapters: 0, last_chapter_added_at: "2026-10-09T12:00:00Z" }),
    ])).toEqual([]);
  });
});
