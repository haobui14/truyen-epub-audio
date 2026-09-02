"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { App } from "@capacitor/app";
import { isNativePlatform } from "@/lib/capacitor";

interface OverlayEntry {
  id: string;
  dismiss: () => void;
}

interface OverlayContextValue {
  register: (entry: OverlayEntry) => () => void;
  dismissTop: () => boolean;
  isTop: (id: string) => boolean;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

export function OverlayProvider({ children }: { children: ReactNode }) {
  const stackRef = useRef<OverlayEntry[]>([]);

  const register = useCallback((entry: OverlayEntry) => {
    stackRef.current = [
      ...stackRef.current.filter((item) => item.id !== entry.id),
      entry,
    ];
    return () => {
      stackRef.current = stackRef.current.filter((item) => item.id !== entry.id);
    };
  }, []);

  const dismissTop = useCallback(() => {
    const entry = stackRef.current.at(-1);
    if (!entry) return false;
    entry.dismiss();
    return true;
  }, []);

  const isTop = useCallback(
    (id: string) => stackRef.current.at(-1)?.id === id,
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissTop()) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dismissTop]);

  useEffect(() => {
    if (!isNativePlatform()) return;
    let removed = false;
    const cleanupRef = { current: () => {} };
    void App.addListener("backButton", ({ canGoBack }) => {
      if (dismissTop()) return;
      if (canGoBack) window.history.back();
      else void App.exitApp();
    }).then((listener) => {
      if (removed) void listener.remove();
      else cleanupRef.current = () => void listener.remove();
    });
    return () => {
      removed = true;
      cleanupRef.current();
    };
  }, [dismissTop]);

  const value = useMemo(
    () => ({ register, dismissTop, isTop }),
    [register, dismissTop, isTop],
  );
  return (
    <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>
  );
}

export function useOverlayManager() {
  const context = useContext(OverlayContext);
  if (!context) {
    throw new Error("useOverlayManager must be used inside OverlayProvider");
  }
  return context;
}
