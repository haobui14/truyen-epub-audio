"use client";
import { useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { getUser, isLoggedIn } from "@/lib/auth";
import { Spinner } from "@/components/ui/Spinner";
import {
  getLevelInfo,
  getLevelProgress,
  getExpToNextLevel,
  formatExp,
  XIANXIA_LEVELS,
} from "@/lib/xianxia";

// ── Level colour ring ─────────────────────────────────────────────────────────
function LevelBadge({ totalExp }: { totalExp: number }) {
  const lvl = getLevelInfo(totalExp);
  const progress = getLevelProgress(totalExp);

  const size = 120;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * progress;

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: size, height: size }}>
        {/* Background ring */}
        <svg
          className="absolute inset-0 -rotate-90"
          width={size}
          height={size}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            className="text-gray-200 dark:text-gray-700"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={lvl.color}
            strokeWidth={stroke}
            strokeDasharray={`${dash} ${circ}`}
            strokeLinecap="round"
          />
        </svg>
        {/* Level number */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-black text-gray-900 dark:text-gray-100 leading-none">
            {lvl.level}
          </span>
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mt-0.5">
            Cấp độ
          </span>
        </div>
      </div>
      <div className="text-center">
        <p
          className="text-base font-bold"
          style={{ color: lvl.color }}
        >
          {lvl.title}
        </p>
        {lvl.nextExp !== null && (
          <p className="text-xs text-gray-400 mt-0.5">
            {formatExp(getExpToNextLevel(totalExp))} EXP tới cấp tiếp
          </p>
        )}
      </div>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 border border-gray-100 dark:border-gray-700 flex flex-col items-center gap-2">
      <div className="text-indigo-500 dark:text-indigo-400">{icon}</div>
      <p className="text-2xl font-black text-gray-900 dark:text-gray-100 tabular-nums">
        {value}
      </p>
      <p className="text-xs font-medium text-gray-400 dark:text-gray-500 text-center">
        {label}
      </p>
    </div>
  );
}

// ── Realm progress table ──────────────────────────────────────────────────────
function RealmTable({ totalExp }: { totalExp: number }) {
  const current = getLevelInfo(totalExp);

  // Group levels by realm name prefix
  const realms = [
    { name: "Luyện Khí", levels: XIANXIA_LEVELS.slice(0, 7) },
    { name: "Trúc Cơ", levels: XIANXIA_LEVELS.slice(7, 10) },
    { name: "Kim Đan", levels: XIANXIA_LEVELS.slice(10, 13) },
    { name: "Nguyên Anh", levels: XIANXIA_LEVELS.slice(13, 16) },
    { name: "Hóa Thần", levels: XIANXIA_LEVELS.slice(16, 19) },
    { name: "Luyện Hư", levels: XIANXIA_LEVELS.slice(19, 20) },
    { name: "Hợp Thể", levels: XIANXIA_LEVELS.slice(20, 21) },
    { name: "Đại Thừa", levels: XIANXIA_LEVELS.slice(21, 22) },
    { name: "Độ Kiếp", levels: XIANXIA_LEVELS.slice(22, 23) },
    { name: "Phi Thăng", levels: XIANXIA_LEVELS.slice(23, 24) },
  ];

  return (
    <div className="space-y-1.5">
      {realms.map((realm) => {
        const firstLevel = realm.levels[0];
        const lastLevel = realm.levels[realm.levels.length - 1];
        const isCurrentRealm = realm.levels.some((l) => l.level === current.level);
        const isPassed = lastLevel.nextExp !== null && totalExp >= lastLevel.nextExp!;
        const isLocked = totalExp < firstLevel.minExp;

        return (
          <div
            key={realm.name}
            className={`flex items-center justify-between px-4 py-2.5 rounded-xl border transition-colors ${
              isCurrentRealm
                ? "border-2 bg-indigo-50 dark:bg-indigo-950/30"
                : isPassed
                ? "border-gray-100 dark:border-gray-700/50 bg-gray-50/50 dark:bg-gray-800/30"
                : "border-gray-100 dark:border-gray-700/50"
            }`}
            style={isCurrentRealm ? { borderColor: firstLevel.color } : undefined}
          >
            <div className="flex items-center gap-2.5">
              {isPassed ? (
                <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              ) : isLocked ? (
                <svg className="w-4 h-4 text-gray-300 dark:text-gray-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              ) : (
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: firstLevel.color }}
                />
              )}
              <span
                className={`text-sm font-semibold ${
                  isCurrentRealm
                    ? "text-gray-900 dark:text-gray-100"
                    : isPassed
                    ? "text-gray-500 dark:text-gray-400"
                    : "text-gray-400 dark:text-gray-500"
                }`}
              >
                {realm.name}
              </span>
            </div>
            <span className="text-xs text-gray-400 tabular-nums">
              {formatExp(firstLevel.minExp)} EXP
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Profile page ──────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const router = useRouter();
  const user = getUser();

  useEffect(() => {
    if (!isLoggedIn()) router.push("/login");
  }, [router]);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["my-stats"],
    queryFn: api.getMyStats,
    enabled: isLoggedIn(),
    staleTime: 30_000,
  });

  const { data: myBooks } = useQuery({
    queryKey: ["my-books"],
    queryFn: api.getMyBooks,
    enabled: isLoggedIn(),
    staleTime: 30_000,
  });

  if (!user) return null;

  const totalExp = stats?.total_exp ?? 0;
  const lvl = getLevelInfo(totalExp);
  const progress = getLevelProgress(totalExp);

  // Avatar initials
  const initials = user.email
    .split("@")[0]
    .slice(0, 2)
    .toUpperCase();

  const booksInProgress = myBooks?.filter(
    (b) => b.chapter.chapter_index + 1 < b.book.total_chapters,
  ).length ?? 0;

  const booksCompleted = myBooks?.filter(
    (b) => b.chapter.chapter_index + 1 >= b.book.total_chapters,
  ).length ?? 0;

  return (
    <div className="max-w-lg mx-auto pb-16">
      {/* Back */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors mb-6"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Trang chủ
      </Link>

      {/* Header card */}
      <div className="bg-white dark:bg-gray-800 rounded-3xl border border-gray-100 dark:border-gray-700 p-6 mb-5 shadow-sm">
        <div className="flex items-start gap-4 mb-6">
          {/* Avatar */}
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center text-xl font-black text-white shrink-0 shadow-md"
            style={{ backgroundColor: lvl.color }}
          >
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">
              {user.email}
            </p>
            <p className="text-sm font-semibold mt-0.5" style={{ color: lvl.color }}>
              {lvl.title}
            </p>
            <p className="text-xs text-gray-400 mt-1 tabular-nums">
              {formatExp(totalExp)} EXP tích lũy
            </p>
          </div>
        </div>

        {/* Level ring + title */}
        {statsLoading ? (
          <div className="flex justify-center py-6">
            <Spinner className="w-6 h-6 text-indigo-500" />
          </div>
        ) : (
          <LevelBadge totalExp={totalExp} />
        )}

        {/* XP progress bar */}
        {!statsLoading && lvl.nextExp !== null && (
          <div className="mt-5">
            <div className="flex justify-between text-xs text-gray-400 mb-1.5">
              <span>{formatExp(totalExp - lvl.minExp)} / {formatExp(lvl.nextExp - lvl.minExp)} EXP</span>
              <span>{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-2.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${progress * 100}%`, backgroundColor: lvl.color }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <StatCard
          label="Chương đã đọc"
          value={(stats?.total_chapters_read ?? 0).toLocaleString()}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          }
        />
        <StatCard
          label="Chương đã nghe"
          value={(stats?.total_chapters_listened ?? 0).toLocaleString()}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          }
        />
        <StatCard
          label="Đang đọc"
          value={booksInProgress}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          }
        />
        <StatCard
          label="Hoàn thành"
          value={booksCompleted}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
            </svg>
          }
        />
      </div>

      {/* How to earn EXP */}
      <div className="bg-indigo-50 dark:bg-indigo-950/30 rounded-2xl border border-indigo-100 dark:border-indigo-900/40 p-4 mb-5">
        <h3 className="text-sm font-bold text-indigo-700 dark:text-indigo-300 mb-2 flex items-center gap-1.5">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Cách nhận EXP
        </h3>
        <ul className="space-y-1 text-xs text-indigo-600 dark:text-indigo-400">
          <li>• <strong>Đọc chương</strong>: bằng số từ ÷ 50 EXP (tối thiểu 10)</li>
          <li>• <strong>Nghe chương</strong>: ×1.5 EXP so với đọc</li>
          <li>• Phải đọc/nghe đủ, không được bỏ qua để nhận EXP</li>
          <li>• Mỗi chương chỉ tính EXP một lần cho mỗi chế độ</li>
        </ul>
      </div>

      {/* Realm table */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 p-4 shadow-sm">
        <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">
          Bảng cảnh giới tu luyện
        </h3>
        <RealmTable totalExp={totalExp} />
      </div>
    </div>
  );
}
