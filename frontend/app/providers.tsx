"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { PlayerProvider } from "@/context/PlayerContext";
import { flushProgressQueue } from "@/lib/progressQueue";
import { hydrateAuthFromNative } from "@/lib/auth";
import { isNativePlatform } from "@/lib/capacitor";
import { api } from "@/lib/api";
import { isLoggedIn, getUser, getToken, setAuth } from "@/lib/auth";

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
      // Sync role from server so existing sessions get the correct role
      // without requiring a re-login (handles new admins and role revocations).
      if (isLoggedIn()) {
        try {
          const me = await api.getMe();
          const user = getUser();
          const token = getToken();
          if (user && token && me.role !== user.role) {
            setAuth(token, { ...user, role: me.role });
          }
        } catch {
          // Expired token — api.ts already cleared auth on 401
        }
      }
    };
    init();
  }, [queryClient]);

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
