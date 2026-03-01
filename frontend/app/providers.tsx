"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { PlayerProvider } from "@/context/PlayerContext";

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
  return (
    <QueryClientProvider client={queryClient}>
      <PlayerProvider>{children}</PlayerProvider>
    </QueryClientProvider>
  );
}
