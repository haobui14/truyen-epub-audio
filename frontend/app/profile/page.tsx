"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { getUser, isLoggedIn, setAuth, getToken, getRefreshToken, type AuthUser } from "@/lib/auth";
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
  const queryClient = useQueryClient();
  // Reactive — re-reads localStorage whenever auth-change fires (same pattern
  // as BottomNav.tsx). Needed because router.refresh() is a no-op in the
  // Capacitor static export and getUser() is not reactive on its own.
  const [user, setUser] = useState<AuthUser | null>(null);

  // Keep user state in sync with any auth changes (login, token refresh, saves)
  // Initial read is deferred to useEffect to avoid SSR/hydration mismatch on Vercel
  useEffect(() => {
    setUser(getUser());
    const sync = () => setUser(getUser());
    window.addEventListener("auth-change", sync);
    return () => window.removeEventListener("auth-change", sync);
  }, []);

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editAvatar, setEditAvatar] = useState<string | null>(null); // base64 preview
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function openEdit() {
    setEditName(user?.display_name ?? "");
    setEditAvatar(user?.avatar_base64 ?? null);
    setSaveError(null);
    setEditOpen(true);
  }

  function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const raw = ev.target?.result as string;
      // Resize to max 400×400 using canvas to keep base64 small
      const img = document.createElement("img");
      img.onload = () => {
        const MAX = 400;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, w, h);
        const b64 = canvas.toDataURL("image/jpeg", 0.75);
        setEditAvatar(b64);
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
    // reset so picking same file again still fires onChange
    e.target.value = "";
  }

  async function handleSave() {
    if (!user) return;
    setSaving(true);
    setSaveError(null);
    try {
      const fields: { display_name?: string; avatar_base64?: string } = {};
      const trimName = editName.trim();
      if (trimName !== (user.display_name ?? "")) fields.display_name = trimName;
      if (editAvatar !== (user.avatar_base64 ?? null)) fields.avatar_base64 = editAvatar ?? "";
      if (Object.keys(fields).length === 0) { setEditOpen(false); return; }
      const result = await api.updateProfile(fields);
      const token = getToken();
      const refresh = getRefreshToken();
      const updatedUser: AuthUser = {
        ...user,
        display_name: result.display_name ?? undefined,
        avatar_base64: result.avatar_base64 ?? undefined,
      };
      if (token) {
        // setAuth writes to localStorage + SharedPreferences and dispatches
        // auth-change, which will update our useState via the listener above.
        await setAuth(token, updatedUser, refresh ?? undefined);
      } else {
        // Fallback: update state directly if somehow token is gone
        setUser(updatedUser);
      }
      queryClient.invalidateQueries({ queryKey: ["my-stats"] });
      setEditOpen(false);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Lỗi lưu thông tin");
    } finally {
      setSaving(false);
    }
  }

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
  const initials = (user.display_name ?? user.email)
    .split(/[\s@]/)[0]
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
          {/* Avatar + edit button */}
          <div className="relative shrink-0">
            {user.avatar_base64 ? (
              <img
                src={user.avatar_base64}
                alt="avatar"
                className="w-16 h-16 rounded-2xl object-cover shadow-md"
              />
            ) : (
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center text-xl font-black text-white shadow-md"
                style={{ backgroundColor: lvl.color }}
              >
                {initials}
              </div>
            )}
            <button
              onClick={openEdit}
              className="absolute -bottom-1.5 -right-1.5 w-6 h-6 rounded-full bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 shadow flex items-center justify-center"
              aria-label="Chỉnh sửa hồ sơ"
            >
              <svg className="w-3 h-3 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 0l.172.172a2 2 0 010 2.828L12 16H9v-3z" />
              </svg>
            </button>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">
              {user.display_name || user.email}
            </p>
            {user.display_name && (
              <p className="text-xs text-gray-400 truncate">{user.email}</p>
            )}
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

      {/* Hidden file input for avatar */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImagePick}
      />

      {/* Edit profile modal */}
      {editOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setEditOpen(false); }}
        >
          <div className="bg-white dark:bg-gray-800 rounded-3xl shadow-2xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-5">
              Chỉnh sửa hồ sơ
            </h2>

            {/* Avatar preview + pick */}
            <div className="flex flex-col items-center gap-3 mb-5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="relative group"
                aria-label="Chọn ảnh đại diện"
              >
                {editAvatar ? (
                  <img
                    src={editAvatar}
                    alt="preview"
                    className="w-20 h-20 rounded-2xl object-cover shadow"
                  />
                ) : (
                  <div
                    className="w-20 h-20 rounded-2xl flex items-center justify-center text-2xl font-black text-white shadow"
                    style={{ backgroundColor: lvl.color }}
                  >
                    {initials}
                  </div>
                )}
                <div className="absolute inset-0 rounded-2xl bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
              </button>
              <span className="text-xs text-gray-400">Nhấn để chọn ảnh</span>
              {editAvatar && (
                <button
                  type="button"
                  onClick={() => setEditAvatar(null)}
                  className="text-xs text-red-500 hover:text-red-600"
                >
                  Xoá ảnh
                </button>
              )}
            </div>

            {/* Display name input */}
            <label className="block mb-4">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5 block">
                Tên hiển thị
              </span>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={user.email}
                maxLength={50}
                className="w-full rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </label>

            {saveError && (
              <p className="text-xs text-red-500 mb-3">{saveError}</p>
            )}

            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => setEditOpen(false)}
                disabled={saving}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                Huỷ
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving && <Spinner className="w-4 h-4 text-white" />}
                Lưu
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
