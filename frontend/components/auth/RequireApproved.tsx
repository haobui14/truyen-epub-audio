"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { isLoggedIn, isAuthReady } from "@/lib/auth";
import { Spinner } from "@/components/ui/Spinner";

/**
 * Gate for reading and listening.
 *
 * The backend refuses chapter text, audio URLs and the EPUB export to anyone
 * without an approved account, so mounting the reader/player for a guest would
 * just fire a wall of 401s. Wrapping at the page level keeps those components
 * from mounting at all.
 *
 * Waits for isAuthReady() before deciding: on Android the token hydrates from
 * SharedPreferences a tick after mount (providers.tsx fires "auth-change" when
 * it lands), and judging too early would flash this prompt at a signed-in user.
 */
export function RequireApproved({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const sync = () => {
      setReady(isAuthReady());
      setAuthed(isLoggedIn());
    };
    sync();
    window.addEventListener("auth-change", sync);
    return () => window.removeEventListener("auth-change", sync);
  }, []);

  if (!ready) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="w-8 h-8 text-accent" />
      </div>
    );
  }

  if (authed) return <>{children}</>;

  return (
    <div className="max-w-sm mx-auto px-4 py-20 text-center">
      <div className="w-14 h-14 bg-accent/15 dark:bg-accent/30 rounded-2xl flex items-center justify-center mx-auto mb-5">
        <svg
          className="w-7 h-7 text-accent"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
          />
        </svg>
      </div>
      <h1 className="text-lg font-bold text-text dark:text-text">
        Cần đăng nhập
      </h1>
      <p className="text-sm text-text-mute dark:text-text-mute mt-2">
        Đăng nhập bằng tài khoản đã được duyệt để đọc và nghe truyện.
      </p>
      <Link
        href="/login"
        className="inline-flex items-center justify-center mt-6 px-5 py-2.5 rounded-xl text-sm font-medium text-white bg-accent hover:bg-accent-dim transition-colors"
      >
        Đăng nhập
      </Link>
    </div>
  );
}
