"use client";
/**
 * APK update notice.
 *
 * The PWA updates itself, but an installed APK never learns a newer build
 * exists. On native only: ask the backend for the latest distributed version
 * (ANDROID_LATEST_VERSION on Railway, bumped after sharing a new APK) and show
 * a dismissible banner when this build is older. Dismissal is remembered per
 * version, so each release nags at most until it's dismissed once.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { isNativePlatform } from "@/lib/capacitor";

const CURRENT = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";

function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map((n) => parseInt(n, 10));
  const c = current.split(".").map((n) => parseInt(n, 10));
  if (l.some(isNaN) || c.some(isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    const a = l[i] || 0;
    const b = c[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

export function UpdateNotice() {
  const [notice, setNotice] = useState<{
    latest: string;
    downloadUrl: string | null;
  } | null>(null);

  useEffect(() => {
    if (!isNativePlatform()) return;
    // Late check — never compete with startup queries for the radio.
    const timer = setTimeout(async () => {
      try {
        const v = await api.getAppVersion();
        if (!isNewer(v.latest, CURRENT)) return;
        if (localStorage.getItem(`update-dismissed-${v.latest}`)) return;
        setNotice({ latest: v.latest, downloadUrl: v.download_url });
      } catch {
        // Offline or backend down — try again next app start.
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, []);

  if (!notice) return null;

  return (
    <div className="fixed bottom-20 left-4 right-4 z-50 rounded-2xl bg-accent/10 ring-1 ring-accent/30 backdrop-blur-md px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text font-medium">
          Có bản cập nhật mới ({notice.latest})
        </p>
        <p className="text-xs text-text-mute mt-0.5">
          Bạn đang dùng bản {CURRENT}
          {notice.downloadUrl ? " — tải bản mới để cập nhật." : "."}
        </p>
      </div>
      {notice.downloadUrl && (
        <a
          href={notice.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-sm font-medium text-accent"
        >
          Tải về
        </a>
      )}
      <button
        type="button"
        aria-label="Đóng"
        className="shrink-0 text-text-mute hover:text-text px-1"
        onClick={() => {
          localStorage.setItem(`update-dismissed-${notice.latest}`, "1");
          setNotice(null);
        }}
      >
        ✕
      </button>
    </div>
  );
}
