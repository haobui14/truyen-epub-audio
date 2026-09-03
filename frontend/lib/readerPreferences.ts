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

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  theme: DEFAULT_READER_THEME,
  customText: DEFAULT_READER_THEME.text,
  customBg: DEFAULT_READER_THEME.bg,
  fontFamily: "serif",
  fontSize: 18,
  lineHeight: 1.8,
  contentWidth: 48,
};

const STORAGE_KEY = "reader-preferences-v2";

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
      32,
      72,
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
