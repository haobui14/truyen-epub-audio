import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import type { Chapter, PaginatedChapters } from "@/types";

function chapter(index: number): Chapter {
  return {
    id: `chapter-${index + 1}`,
    book_id: "book-1",
    chapter_index: index,
    title: `Chapter ${index + 1}`,
    word_count: 100,
    status: "ready",
    updated_at: "2026-09-15T00:00:00Z",
  };
}

function response(payload: PaginatedChapters) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.getAllBookChapters", () => {
  it("loads chapter 1001 instead of trusting a single capped page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      const items =
        page === 1
          ? Array.from({ length: 1000 }, (_, index) => chapter(index))
          : [chapter(1000)];
      return response({
        items,
        total: 1001,
        page,
        page_size: 1000,
        total_pages: 2,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.getAllBookChapters("book-1");

    expect(result.items).toHaveLength(1001);
    expect(result.items.at(-1)?.chapter_index).toBe(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("page_size=1000");
    expect(String(fetchMock.mock.calls[1][0])).toContain("page=2");
  });
});
