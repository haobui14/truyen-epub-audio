"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getUser, clearAuth, isAdmin as checkAdmin } from "@/lib/auth";
import type { AuthUser } from "@/lib/auth";

/** Indicator pill that highlights the active tab */
function Pill({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`flex items-center justify-center w-12 h-7 rounded-full transition-colors ${
        active
          ? "bg-accent/15 ring-1 ring-accent/30 shadow-[0_0_18px_var(--color-accent-glow)]"
          : ""
      }`}
    >
      {children}
    </span>
  );
}

export function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [admin, setAdmin] = useState(false);
  // Sheet is "open" only when the stored pathname matches the current route.
  // Navigating away automatically closes it with no setState-in-effect needed.
  const [sheetPathname, setSheetPathname] = useState<string | null>(null);
  const sheetOpen = sheetPathname === pathname;
  const openSheet = () => setSheetPathname(pathname);
  const closeSheet = () => setSheetPathname(null);

  useEffect(() => {
    const sync = () => {
      setUser(getUser());
      setAdmin(checkAdmin());
    };
    sync();
    window.addEventListener("auth-change", sync);
    return () => window.removeEventListener("auth-change", sync);
  }, []);

  // Lock body scroll while the profile sheet is open so dragging the backdrop
  // doesn't scroll the library page behind it.
  useEffect(() => {
    if (!sheetOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sheetOpen]);

  const at = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const tabCls = (href: string) =>
    `flex-1 flex flex-col items-center justify-center gap-0.5 py-1 text-[10px] font-medium tracking-wide transition-colors ${
      at(href) ? "text-accent" : "text-text-faint"
    }`;

  const profileActive =
    pathname.startsWith("/login") ||
    pathname.startsWith("/profile") ||
    sheetOpen;
  const btnCls = `flex-1 flex flex-col items-center justify-center gap-0.5 py-1 text-[10px] font-medium tracking-wide transition-colors ${
    profileActive ? "text-accent" : "text-text-faint"
  }`;

  return (
    <>
      <nav
        className="fixed bottom-0 left-0 right-0 z-30 bg-ink/95 backdrop-blur-xl border-t border-hairline-soft"
        style={{ paddingBottom: "var(--sab)" }}
      >
        <div className="flex items-stretch h-14">
          {/* Library */}
          <Link href="/" className={tabCls("/")}>
            <Pill active={at("/")}>
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={at("/") ? 2.4 : 1.75}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                />
              </svg>
            </Pill>
            Thư viện
          </Link>

          {/* Search */}
          <Link href="/search" className={tabCls("/search")}>
            <Pill active={at("/search")}>
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={at("/search") ? 2.4 : 1.75}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </Pill>
            Tìm kiếm
          </Link>

          {/* My Books */}
          <Link href="/my-books" className={tabCls("/my-books")}>
            <Pill active={at("/my-books")}>
              <svg
                className="w-5 h-5"
                fill={at("/my-books") ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth={1.75}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
                />
              </svg>
            </Pill>
            Của tôi
          </Link>

          {/* Profile */}
          <button
            onClick={() => (user ? openSheet() : router.push("/login"))}
            className={btnCls}
          >
            <Pill active={profileActive}>
              {user ? (
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold transition-colors ${
                    profileActive
                      ? "bg-accent text-ink"
                      : "bg-raised-hi text-text-dim"
                  }`}
                >
                  {user.email.charAt(0).toUpperCase()}
                </span>
              ) : (
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                  />
                </svg>
              )}
            </Pill>
            {user ? "Hồ sơ" : "Đăng nhập"}
          </button>
        </div>
      </nav>

      {/* Profile bottom sheet */}
      {sheetOpen && user && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60"
            style={{ touchAction: "none" }}
            onClick={closeSheet}
          />
          <div
            className="fixed left-0 right-0 z-50 bg-surface border-t border-hairline rounded-t-2xl shadow-[0_-20px_60px_rgba(0,0,0,0.5)] animate-slide-up"
            style={{ bottom: "calc(3.5rem + var(--sab))" }}
          >
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-9 h-1 bg-hairline rounded-full" />
            </div>

            {/* User info header */}
            <div className="px-5 py-3 flex items-center gap-3 border-b border-hairline-soft">
              <div className="w-11 h-11 rounded-full bg-accent text-ink flex items-center justify-center text-base font-semibold shrink-0 shadow-[0_0_18px_var(--color-accent-glow)]">
                {user.email.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text truncate">
                  {user.email}
                </p>
                {admin && (
                  <span className="font-mono text-[10px] tracking-widest uppercase text-vermillion">
                    Admin
                  </span>
                )}
              </div>
            </div>

            <div className="py-1.5">
              {/* Profile page */}
              <Link
                href="/profile"
                onClick={closeSheet}
                className="flex items-center gap-3.5 px-5 py-3 hover:bg-raised transition-colors"
              >
                <span className="w-8 h-8 rounded-full bg-accent/15 ring-1 ring-accent/25 flex items-center justify-center shrink-0">
                  <svg
                    className="w-4 h-4 text-accent"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-dim">
                    Trang cá nhân
                  </span>
                  <p className="text-xs text-text-faint">
                    Cấp độ &amp; thống kê tu luyện
                  </p>
                </div>
                <svg
                  className="w-4 h-4 text-text-faint shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </Link>
              <div className="h-px mx-5 bg-hairline-soft my-1" />

              {admin && (
                <>
                  <Link
                    href="/upload"
                    onClick={closeSheet}
                    className="flex items-center gap-3.5 px-5 py-3 hover:bg-raised transition-colors"
                  >
                    <span className="w-8 h-8 rounded-full bg-accent/15 ring-1 ring-accent/25 flex items-center justify-center shrink-0">
                      <svg
                        className="w-4 h-4 text-accent"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                        />
                      </svg>
                    </span>
                    <span className="text-sm font-medium text-text-dim">
                      Tải lên truyện
                    </span>
                  </Link>
                  <Link
                    href="/admin/manage-books"
                    onClick={closeSheet}
                    className="flex items-center gap-3.5 px-5 py-3 hover:bg-raised transition-colors"
                  >
                    <span className="w-8 h-8 rounded-full bg-vermillion/15 ring-1 ring-vermillion/30 flex items-center justify-center shrink-0">
                      <svg
                        className="w-4 h-4 text-vermillion"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                        />
                      </svg>
                    </span>
                    <span className="text-sm font-medium text-text-dim">
                      Quản lý truyện
                    </span>
                  </Link>
                  <Link
                    href="/admin/users"
                    onClick={closeSheet}
                    className="flex items-center gap-3.5 px-5 py-3 hover:bg-raised transition-colors"
                  >
                    <span className="w-8 h-8 rounded-full bg-gold/15 ring-1 ring-gold/30 flex items-center justify-center shrink-0">
                      <svg
                        className="w-4 h-4 text-gold"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M17 20h5v-2a3 3 0 00-5.36-1.86M17 20H7m10 0v-2c0-.66-.13-1.3-.36-1.86m0 0a5 5 0 00-9.28 0M7 20H2v-2a3 3 0 015.36-1.86M7 20v-2c0-.66.13-1.3.36-1.86m0 0a5 5 0 019.28 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                    </span>
                    <span className="text-sm font-medium text-text-dim">
                      Người dùng
                    </span>
                  </Link>
                  <div className="h-px mx-5 bg-hairline-soft my-1" />
                </>
              )}

              <button
                onClick={() => {
                  clearAuth();
                  closeSheet();
                }}
                className="w-full flex items-center gap-3.5 px-5 py-3 hover:bg-vermillion/10 transition-colors"
              >
                <span className="w-8 h-8 rounded-full bg-vermillion/15 ring-1 ring-vermillion/30 flex items-center justify-center shrink-0">
                  <svg
                    className="w-4 h-4 text-vermillion"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                    />
                  </svg>
                </span>
                <span className="text-sm font-medium text-vermillion">
                  Đăng xuất
                </span>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
