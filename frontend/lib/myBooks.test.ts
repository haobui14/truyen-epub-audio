import { describe, expect, it } from "vitest";
import { parseMyBooksResponse } from "./myBooks";

describe("parseMyBooksResponse", () => {
  it("keeps the array contract used by all my-books query consumers", () => {
    const entries = [{ book: { id: "book-1" } }];

    expect(parseMyBooksResponse(entries)).toBe(entries);
  });

  it("rejects a wrapped response before a component can call map on it", () => {
    expect(() => parseMyBooksResponse({ entries: [] })).toThrow(
      "Dữ liệu tiến độ không hợp lệ",
    );
  });
});
