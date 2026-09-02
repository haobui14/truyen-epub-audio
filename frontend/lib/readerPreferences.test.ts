import { describe, expect, it } from "vitest";
import { contrastRatio } from "./readerPreferences";

describe("reader color contrast", () => {
  it("accepts a high-contrast light theme", () => {
    expect(contrastRatio("#1f2937", "#ffffff")).toBeGreaterThan(7);
  });

  it("rejects unreadable custom colors", () => {
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });
});

