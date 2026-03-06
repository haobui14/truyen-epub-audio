"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { PlayerProvider } from "@/context/PlayerContext";
import { flushProgressQueue } from "@/lib/progressQueue";
import { hydrateAuthFromNative } from "@/lib/auth";
import { isNativePlatform } from "@/lib/capacitor";

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
  // After hydration, invalidate all queries so they re-run with the
  // restored token (avoids a stale 401 error state from the initial load).
  useEffect(() => {
    if (!isNativePlatform()) return;
    hydrateAuthFromNative().then(() => {
      window.dispatchEvent(new Event("auth-change"));
      queryClient.invalidateQueries();
    });
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
