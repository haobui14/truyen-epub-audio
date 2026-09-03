import { describe, expect, it } from "vitest";
import {
  DEFAULT_READER_PREFERENCES,
  contrastRatio,
  normalizeReaderPreferences,
} from "./readerPreferences";

describe("reader color contrast", () => {
  it("accepts a high-contrast light theme", () => {
    expect(contrastRatio("#1f2937", "#ffffff")).toBeGreaterThan(7);
  });

  it("rejects unreadable custom colors", () => {
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });

  it("clamps malformed persisted layout settings", () => {
    const preferences = normalizeReaderPreferences({
      ...DEFAULT_READER_PREFERENCES,
      fontSize: 200,
      lineHeight: 0.5,
      contentWidth: 500,
    });

    expect(preferences.fontSize).toBe(24);
    expect(preferences.lineHeight).toBe(1.4);
    expect(preferences.contentWidth).toBe(72);
  });

  it("does not restore an inaccessible active palette", () => {
    const preferences = normalizeReaderPreferences({
      ...DEFAULT_READER_PREFERENCES,
      theme: {
        name: "custom",
        label: "Tùy chọn",
        text: "#777777",
        bg: "#777777",
      },
      customText: "#777777",
      customBg: "#777777",
    });

    expect(preferences.theme).toEqual(DEFAULT_READER_PREFERENCES.theme);
    expect(preferences.customText).toBe("#777777");
    expect(preferences.customBg).toBe("#777777");
  });
});
