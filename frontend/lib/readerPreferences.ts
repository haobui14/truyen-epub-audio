export interface ReaderTheme {
  name: string;
  bg: string;
  text: string;
  label: string;
}

export interface ReaderPreferences {
  theme: ReaderTheme;
  customText: string;
  customBg: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
}

export const DEFAULT_READER_THEME: ReaderTheme = {
  name: "auto",
  bg: "#ffffff",
  text: "#1f2937",
  label: "Tự động",
};

// Line length, in `ch` of the page font (Inter 16px, 1ch ≈ 10px). The old
// 32–72 range with a 48 default gave a ~485px column — a phone-width strip in
// the middle of a desktop screen. 88 ≈ 890px; 112 ≈ 1130px fills the reader's
// max-w-6xl container. Phones are unaffected: the column is already capped by
// the screen long before either limit.
export const CONTENT_WIDTH = { min: 32, max: 112, step: 4 } as const;

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  theme: DEFAULT_READER_THEME,
  customText: DEFAULT_READER_THEME.text,
  customBg: DEFAULT_READER_THEME.bg,
  fontFamily: "serif",
  fontSize: 18,
  lineHeight: 1.8,
  contentWidth: 88,
};

const STORAGE_KEY = "reader-preferences-v3";
const V2_STORAGE_KEY = "reader-preferences-v2";

/**
 * v2 saved the whole preferences object on ANY change, so almost every reader
 * has contentWidth: 48 stored — the old default, never chosen. Keeping it would
 * leave them on the narrow column forever. 48 (old default) and 72 (old
 * maximum, i.e. "as wide as it goes") both move to the new default; any other
 * value was picked deliberately and is kept.
 */
export function migrateV2Preferences(saved: unknown): unknown {
  if (!isRecord(saved)) return saved;
  const width = Number(saved.contentWidth);
  if (width === 48 || width === 72) {
    const rest = { ...saved };
    delete rest.contentWidth;
    return rest;
  }
  return saved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(max, Math.max(min, numeric))
    : fallback;
}

function readTheme(value: unknown): ReaderTheme {
  if (!isRecord(value)) return DEFAULT_READER_THEME;
  const bg = isHexColor(value.bg) ? value.bg : DEFAULT_READER_THEME.bg;
  const text = isHexColor(value.text) ? value.text : DEFAULT_READER_THEME.text;
  const name = typeof value.name === "string" ? value.name : "auto";
  const label = typeof value.label === "string" ? value.label : "Tự động";
  if (contrastRatio(text, bg) < 4.5) return DEFAULT_READER_THEME;
  return { name, label, bg, text };
}

export function normalizeReaderPreferences(value: unknown): ReaderPreferences {
  if (!isRecord(value)) return { ...DEFAULT_READER_PREFERENCES };
  const theme = readTheme(value.theme);
  return {
    theme,
    customText: isHexColor(value.customText) ? value.customText : theme.text,
    customBg: isHexColor(value.customBg) ? value.customBg : theme.bg,
    fontFamily:
      typeof value.fontFamily === "string" && value.fontFamily.length <= 80
        ? value.fontFamily
        : DEFAULT_READER_PREFERENCES.fontFamily,
    fontSize: clampNumber(
      value.fontSize,
      14,
      24,
      DEFAULT_READER_PREFERENCES.fontSize,
    ),
    lineHeight: clampNumber(
      value.lineHeight,
      1.4,
      2.2,
      DEFAULT_READER_PREFERENCES.lineHeight,
    ),
    contentWidth: clampNumber(
      value.contentWidth,
      CONTENT_WIDTH.min,
      CONTENT_WIDTH.max,
      DEFAULT_READER_PREFERENCES.contentWidth,
    ),
  };
}

export function loadReaderPreferences(): ReaderPreferences {
  if (typeof window === "undefined") return DEFAULT_READER_PREFERENCES;
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) {
      return normalizeReaderPreferences({
        ...DEFAULT_READER_PREFERENCES,
        ...JSON.parse(current),
      });
    }
    const v2 = localStorage.getItem(V2_STORAGE_KEY);
    if (v2) {
      return normalizeReaderPreferences({
        ...DEFAULT_READER_PREFERENCES,
        ...(migrateV2Preferences(JSON.parse(v2)) as object),
      });
    }
    const legacyTheme = localStorage.getItem("reader-theme");
    const theme = legacyTheme ? (JSON.parse(legacyTheme) as ReaderTheme) : DEFAULT_READER_THEME;
    return normalizeReaderPreferences({
      ...DEFAULT_READER_PREFERENCES,
      theme,
      customText: theme.text,
      customBg: theme.bg,
      fontFamily: localStorage.getItem("reader-font-family") || "serif",
      fontSize: Number(localStorage.getItem("reader-font-size")) || 18,
    });
  } catch {
    return DEFAULT_READER_PREFERENCES;
  }
}

export function saveReaderPreferences(preferences: ReaderPreferences) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(normalizeReaderPreferences(preferences)),
  );
}

function luminance(hex: string) {
  const value = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return 0;
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function contrastRatio(foreground: string, background: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}
