import { describe, expect, it } from "vitest";
import {
  CONTENT_WIDTH,
  DEFAULT_READER_PREFERENCES,
  contrastRatio,
  migrateV2Preferences,
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
    expect(preferences.contentWidth).toBe(CONTENT_WIDTH.max);
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

describe("v2 → v3 line-length migration", () => {
  const load = (saved: Record<string, unknown>) =>
    normalizeReaderPreferences({
      ...DEFAULT_READER_PREFERENCES,
      ...(migrateV2Preferences(saved) as object),
    });

  it("moves the untouched old default (48) onto the new wider default", () => {
    expect(load({ ...DEFAULT_READER_PREFERENCES, contentWidth: 48 }).contentWidth).toBe(
      DEFAULT_READER_PREFERENCES.contentWidth,
    );
  });

  it("treats the old maximum (72) as 'as wide as possible'", () => {
    expect(load({ ...DEFAULT_READER_PREFERENCES, contentWidth: 72 }).contentWidth).toBe(
      DEFAULT_READER_PREFERENCES.contentWidth,
    );
  });

  it("keeps a width the reader chose deliberately", () => {
    expect(load({ ...DEFAULT_READER_PREFERENCES, contentWidth: 40 }).contentWidth).toBe(40);
  });

  it("keeps every other saved setting", () => {
    const migrated = load({ ...DEFAULT_READER_PREFERENCES, contentWidth: 48, fontSize: 22 });
    expect(migrated.fontSize).toBe(22);
  });
});
