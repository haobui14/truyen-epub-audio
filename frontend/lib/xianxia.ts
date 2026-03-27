/**
 * Xianxia cultivation level system.
 * EXP awarded per chapter: max(10, ceil(wordCount / 50)) for reading; ×1.5 for listening.
 * Example: 2 000-word chapter → 40 EXP reading / 60 EXP listening.
 */

export interface XianxiaLevel {
  level: number;
  /** Cultivation realm title shown to the user */
  title: string;
  /** Colour used for badges / accents */
  color: string;
  /** Minimum cumulative EXP to enter this level */
  minExp: number;
  /** Minimum cumulative EXP for the next level (null = max level) */
  nextExp: number | null;
}

export const XIANXIA_LEVELS: XianxiaLevel[] = [
  { level: 1,  title: "Luyện Khí Tầng 1",    color: "#94a3b8", minExp: 0,       nextExp: 100 },
  { level: 2,  title: "Luyện Khí Tầng 2",    color: "#94a3b8", minExp: 100,     nextExp: 220 },
  { level: 3,  title: "Luyện Khí Tầng 3",    color: "#94a3b8", minExp: 220,     nextExp: 370 },
  { level: 4,  title: "Luyện Khí Tầng 4",    color: "#94a3b8", minExp: 370,     nextExp: 550 },
  { level: 5,  title: "Luyện Khí Tầng 5",    color: "#94a3b8", minExp: 550,     nextExp: 770 },
  { level: 6,  title: "Luyện Khí Tầng 6",    color: "#94a3b8", minExp: 770,     nextExp: 1050 },
  { level: 7,  title: "Luyện Khí Tầng 7",    color: "#94a3b8", minExp: 1050,    nextExp: 1400 },
  { level: 8,  title: "Trúc Cơ Sơ Kỳ",       color: "#34d399", minExp: 1400,    nextExp: 2200 },
  { level: 9,  title: "Trúc Cơ Trung Kỳ",    color: "#34d399", minExp: 2200,    nextExp: 3200 },
  { level: 10, title: "Trúc Cơ Hậu Kỳ",      color: "#34d399", minExp: 3200,    nextExp: 5000 },
  { level: 11, title: "Kim Đan Sơ Kỳ",        color: "#facc15", minExp: 5000,    nextExp: 7500 },
  { level: 12, title: "Kim Đan Trung Kỳ",     color: "#facc15", minExp: 7500,    nextExp: 11000 },
  { level: 13, title: "Kim Đan Hậu Kỳ",       color: "#facc15", minExp: 11000,   nextExp: 15000 },
  { level: 14, title: "Nguyên Anh Sơ Kỳ",    color: "#fb923c", minExp: 15000,   nextExp: 22000 },
  { level: 15, title: "Nguyên Anh Trung Kỳ", color: "#fb923c", minExp: 22000,   nextExp: 31000 },
  { level: 16, title: "Nguyên Anh Hậu Kỳ",   color: "#fb923c", minExp: 31000,   nextExp: 40000 },
  { level: 17, title: "Hóa Thần Sơ Kỳ",      color: "#f472b6", minExp: 40000,   nextExp: 60000 },
  { level: 18, title: "Hóa Thần Trung Kỳ",   color: "#f472b6", minExp: 60000,   nextExp: 85000 },
  { level: 19, title: "Hóa Thần Hậu Kỳ",     color: "#f472b6", minExp: 85000,   nextExp: 100000 },
  { level: 20, title: "Luyện Hư Kỳ",          color: "#a78bfa", minExp: 100000,  nextExp: 250000 },
  { level: 21, title: "Hợp Thể Kỳ",           color: "#60a5fa", minExp: 250000,  nextExp: 500000 },
  { level: 22, title: "Đại Thừa Kỳ",          color: "#38bdf8", minExp: 500000,  nextExp: 1000000 },
  { level: 23, title: "Độ Kiếp Kỳ",           color: "#f87171", minExp: 1000000, nextExp: 2000000 },
  { level: 24, title: "Phi Thăng Tiên Giới",  color: "#fbbf24", minExp: 2000000, nextExp: null },
];

/** Return the level entry for a given total EXP. */
export function getLevelInfo(totalExp: number): XianxiaLevel {
  for (let i = XIANXIA_LEVELS.length - 1; i >= 0; i--) {
    if (totalExp >= XIANXIA_LEVELS[i].minExp) return XIANXIA_LEVELS[i];
  }
  return XIANXIA_LEVELS[0];
}

/** Progress within the current level, 0–1. Returns 1 at max level. */
export function getLevelProgress(totalExp: number): number {
  const lvl = getLevelInfo(totalExp);
  if (lvl.nextExp === null) return 1;
  const span = lvl.nextExp - lvl.minExp;
  const done = totalExp - lvl.minExp;
  return Math.min(done / span, 1);
}

/** EXP needed to reach next level from current total, or 0 if max level. */
export function getExpToNextLevel(totalExp: number): number {
  const lvl = getLevelInfo(totalExp);
  if (lvl.nextExp === null) return 0;
  return lvl.nextExp - totalExp;
}

/** Pretty-format a large EXP number. */
export function formatExp(exp: number): string {
  if (exp >= 1_000_000) return `${(exp / 1_000_000).toFixed(1)}M`;
  if (exp >= 1_000) return `${(exp / 1_000).toFixed(1)}K`;
  return String(exp);
}
