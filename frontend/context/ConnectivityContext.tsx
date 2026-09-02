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
import { Network, type ConnectionType } from "@capacitor/network";
import { isNativePlatform } from "@/lib/capacitor";

interface ConnectivityValue {
  online: boolean;
  connectionType: ConnectionType | "unknown";
  lastOnlineAt: number | null;
  refresh: () => Promise<void>;
}

const ConnectivityContext = createContext<ConnectivityValue | null>(null);

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );
  const [connectionType, setConnectionType] = useState<
    ConnectionType | "unknown"
  >("unknown");
  const [lastOnlineAt, setLastOnlineAt] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = Number(localStorage.getItem("connectivity-last-online"));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });

  const applyStatus = useCallback(
    (connected: boolean, type: ConnectionType | "unknown") => {
      setOnline(connected);
      setConnectionType(type);
      if (connected) {
        const now = Date.now();
        setLastOnlineAt(now);
        localStorage.setItem("connectivity-last-online", String(now));
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (isNativePlatform()) {
      const status = await Network.getStatus();
      applyStatus(status.connected, status.connectionType);
    } else {
      applyStatus(navigator.onLine, navigator.onLine ? "unknown" : "none");
    }
  }, [applyStatus]);

  useEffect(() => {
    if (isNativePlatform()) {
      let removed = false;
      let cleanup = () => {};
      const initialCheck = window.setTimeout(() => void refresh(), 0);
      void Network.addListener("networkStatusChange", (status) => {
        applyStatus(status.connected, status.connectionType);
      }).then((listener) => {
        if (removed) void listener.remove();
        else cleanup = () => void listener.remove();
      });
      return () => {
        window.clearTimeout(initialCheck);
        removed = true;
        cleanup();
      };
    }
    const onOnline = () => applyStatus(true, "unknown");
    const onOffline = () => applyStatus(false, "none");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [applyStatus, refresh]);

  const value = useMemo(
    () => ({ online, connectionType, lastOnlineAt, refresh }),
    [online, connectionType, lastOnlineAt, refresh],
  );
  return (
    <ConnectivityContext.Provider value={value}>
      {children}
    </ConnectivityContext.Provider>
  );
}

export function useConnectivity() {
  const context = useContext(ConnectivityContext);
  if (!context) {
    throw new Error("useConnectivity must be used inside ConnectivityProvider");
  }
  return context;
}
