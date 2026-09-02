"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { usePlayerContext } from "./PlayerContext";
import { isReaderRoute } from "@/lib/readerRoute";
import { IconButton } from "@/components/ui/Button";

export interface AppNotice {
  id: string;
  title: string;
  message?: string;
  tone?: "default" | "warning" | "error";
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
  durationMs?: number | null;
}

interface NoticeContextValue {
  showNotice: (notice: AppNotice) => void;
  dismissNotice: (id: string) => void;
}

const NoticeContext = createContext<NoticeContextValue | null>(null);

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<AppNotice[]>([]);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const pathname = usePathname();
  const { session } = usePlayerContext();

  const dismissNotice = useCallback((id: string) => {
    setNotices((current) => {
      const removed = current.find((item) => item.id === id);
      removed?.onDismiss?.();
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const showNotice = useCallback((notice: AppNotice) => {
    setNotices((current) => [
      ...current.filter((item) => item.id !== notice.id),
      notice,
    ]);
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      setKeyboardOffset(covered > 100 ? covered : 0);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    const timers = notices
      .filter((notice) => notice.durationMs !== null && (notice.durationMs ?? 0) > 0)
      .map((notice) =>
        window.setTimeout(
          () => dismissNotice(notice.id),
          notice.durationMs ?? 5000,
        ),
      );
    return () => timers.forEach(window.clearTimeout);
  }, [dismissNotice, notices]);

  const value = useMemo(
    () => ({ showNotice, dismissNotice }),
    [dismissNotice, showNotice],
  );
  const reading = isReaderRoute(pathname);
  const baseOffset = reading
    ? session.active
      ? "7.75rem"
      : "4.75rem"
    : session.active
      ? "8.25rem"
      : "4.25rem";

  return (
    <NoticeContext.Provider value={value}>
      {children}
      {notices.length > 0 && (
        <div
          className="pointer-events-none fixed inset-x-3 z-[65] mx-auto flex max-w-xl flex-col gap-2"
          style={{
            bottom: `calc(${baseOffset} + var(--sab) + ${keyboardOffset}px)`,
          }}
          aria-live="polite"
          aria-atomic="false"
        >
          {notices.map((notice) => (
            <section
              key={notice.id}
              className={`pointer-events-auto flex items-center gap-3 rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-xl ${
                notice.tone === "error"
                  ? "border-vermillion/40 bg-ink/95"
                  : notice.tone === "warning"
                    ? "border-gold/40 bg-ink/95"
                    : "border-accent/30 bg-ink/95"
              }`}
              role={notice.tone === "error" ? "alert" : "status"}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text">{notice.title}</p>
                {notice.message && (
                  <p className="mt-0.5 text-xs leading-relaxed text-text-mute">
                    {notice.message}
                  </p>
                )}
              </div>
              {notice.actionLabel && notice.onAction && (
                <button
                  type="button"
                  onClick={notice.onAction}
                  className="min-h-11 shrink-0 rounded-lg px-2 text-sm font-semibold text-accent transition-[opacity,transform] active:scale-[0.96]"
                >
                  {notice.actionLabel}
                </button>
              )}
              <IconButton label="Đóng thông báo" onClick={() => dismissNotice(notice.id)}>
                <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
              </IconButton>
            </section>
          ))}
        </div>
      )}
    </NoticeContext.Provider>
  );
}

export function useNotices() {
  const context = useContext(NoticeContext);
  if (!context) throw new Error("useNotices must be used inside NoticeProvider");
  return context;
}

