"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { PlayerProvider } from "@/context/PlayerContext";
import { flushProgressQueue } from "@/lib/progressQueue";
import { hydrateAuthFromNative } from "@/lib/auth";
import { isNativePlatform } from "@/lib/capacitor";
import { api, tryRefreshToken } from "@/lib/api";
import {
  isLoggedIn,
  getUser,
  getToken,
  getRefreshToken,
  setAuth,
} from "@/lib/auth";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Don't retry on 401 — the token is invalid; retrying only generates
            // more noise. For other errors a single retry is still useful.
            retry: (failureCount, error) => {
              if ((error as Error)?.message?.includes("401")) return false;
              return failureCount < 1;
            },
            staleTime: 30_000,
          },
        },
      }),
  );

  // On native, restore auth from SharedPreferences into localStorage.
  // After hydration, sync role from server and invalidate all queries.
  useEffect(() => {
    const init = async () => {
      if (isNativePlatform()) {
        await hydrateAuthFromNative();
        window.dispatchEvent(new Event("auth-change"));
        queryClient.invalidateQueries();
      }
      // Proactively refresh the access token on every app start. Track whether
      // it succeeded — if the refresh fails (expired refresh token OR network
      // down), we must NOT call getMe() with the stale access token because
      // that path ends in: 401 → tryRefreshToken() fails → clearAuth() → logout.
      // Instead, leave auth as-is and let the user keep their session until
      // they perform a real authenticated action with network available.
      // (Access tokens expire in 1 hour; refresh tokens last 90 days.)
      let tokenOk = isLoggedIn() && !getRefreshToken(); // no refresh token = rely on existing access token
      if (isLoggedIn() && getRefreshToken()) {
        tokenOk = (await tryRefreshToken()) === true;
      }

      // Sync role from server — best-effort only when we have a fresh token.
      // Skipping this on failed refresh avoids the 401 → clearAuth() path.
      if (isLoggedIn() && tokenOk) {
        try {
          const me = await api.getMe();
          const user = getUser();
          const token = getToken();
          if (user && token && me.role !== user.role) {
            await setAuth(token, { ...user, role: me.role });
          }
        } catch {
          // Best-effort — ignore failures (e.g. server down)
        }
      }
    };
    init();
  }, [queryClient]);

  // Refresh token and re-hydrate auth whenever the app comes back to the
  // foreground (e.g. after screen-off on Android). Without this, the access
  // token expires while backgrounded and the first API call after resume
  // triggers a 401 → clearAuth() → user gets logged out.
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== "visible") return;
      if (isNativePlatform()) {
        await hydrateAuthFromNative();
      }
      if (isLoggedIn() && getRefreshToken()) {
        const ok = await tryRefreshToken();
        if (ok) {
          // Skip progress queries — refetching them while playing causes
          // setTrack() to re-fire with a stale server position, which stops
          // or jumps the player back on screen-on.
          queryClient.invalidateQueries({
            predicate: (query) => query.queryKey[0] !== "progress",
          });
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [queryClient]);

  // Proactively refresh the access token every 45 minutes while the app is
  // open. Access tokens expire after 1 hour; refreshing at 45 min ensures the
  // token never actually expires during an active session, avoiding the
  // reactive 401 → refresh path which can fail on cold Railway starts.
  useEffect(() => {
    const REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes
    const id = setInterval(async () => {
      if (isLoggedIn() && getRefreshToken()) {
        await tryRefreshToken();
      }
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Flush queued offline progress when connectivity is restored
  useEffect(() => {
    const handleOnline = () => {
      flushProgressQueue();
    };
    window.addEventListener("online", handleOnline);
    // Also attempt flush on app start (in case user was offline last session)
    flushProgressQueue();
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <PlayerProvider>
        <NativeUrlRestorer />
        {children}
      </PlayerProvider>
    </QueryClientProvider>
  );
}

/**
 * Saves the current URL to localStorage on every navigation so it can be
 * restored after Android kills the app process (screen-off → process death).
 *
 * Detection: sessionStorage is cleared on process death but localStorage is
 * not. On first mount with no sessionStorage marker → process death → restore
 * from localStorage. On a normal resume sessionStorage still has the marker.
 */
function NativeUrlRestorer() {
  const router = useRouter();
  const pathname = usePathname();
  // Prevents the pathname save-effect from overwriting the last URL with "/"
  // during the brief moment between starting the restore navigation and the
  // target URL being committed by the router.
  const isRestoringRef = useRef(false);

  // On first mount: if sessionStorage is empty this is a fresh process start
  // (process death). Try to navigate back to the last visited page.
  useEffect(() => {
    if (!isNativePlatform()) return;
    if (sessionStorage.getItem("app-session")) return; // normal resume
    sessionStorage.setItem("app-session", "1");

    const lastUrl = localStorage.getItem("native-last-url");
    if (lastUrl && lastUrl !== "/" && !lastUrl.startsWith("/login")) {
      isRestoringRef.current = true;
      router.replace(lastUrl);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist current URL on every navigation (strip ?autoplay=1 so restoration
  // doesn't force-resume playback — user taps play to continue).
  useEffect(() => {
    if (!isNativePlatform()) return;
    // Skip saving the transient "/" during a process-death restore navigation.
    if (isRestoringRef.current) {
      isRestoringRef.current = false;
      return;
    }
    try {
      const urlObj = new URL(window.location.href);
      urlObj.searchParams.delete("autoplay");
      const qs = urlObj.searchParams.toString();
      const cleanUrl = urlObj.pathname + (qs ? "?" + qs : "");
      localStorage.setItem("native-last-url", cleanUrl || "/");
    } catch {
      // URL parsing failed — skip
    }
  }, [pathname]);

  return null;
}
