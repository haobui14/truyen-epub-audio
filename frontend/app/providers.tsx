"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { PlayerProvider } from "@/context/PlayerContext";
import { flushProgressQueue } from "@/lib/progressQueue";
import { hydrateAuthFromNative } from "@/lib/auth";
import { isNativePlatform } from "@/lib/capacitor";
import { api, tryRefreshToken } from "@/lib/api";
import { isLoggedIn, getUser, getToken, getRefreshToken, setAuth } from "@/lib/auth";

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
      // (Requires Supabase refresh token expiry ≥ 15552000 s / 180 days.)
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
        if (ok) queryClient.invalidateQueries();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [queryClient]);

  // Proactively refresh the access token every 45 minutes while the app is
  // open. Supabase access tokens expire after 1 hour; refreshing at 45 min
  // ensures the token never actually expires during an active session, avoiding
  // the reactive 401 → refresh path which can fail on cold Railway starts.
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
      <PlayerProvider>{children}</PlayerProvider>
    </QueryClientProvider>
  );
}
