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
import { useEffect } from "react";
import { api } from "@/lib/api";
import { isNativePlatform } from "@/lib/capacitor";
import { useNotices } from "@/context/NoticeContext";

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
  const { showNotice } = useNotices();

  useEffect(() => {
    if (!isNativePlatform()) return;
    // Late check — never compete with startup queries for the radio.
    const timer = setTimeout(async () => {
      try {
        const v = await api.getAppVersion();
        const latest = v.version_name || v.latest;
        const mandatory = !!v.minimum_supported_version &&
          isNewer(v.minimum_supported_version, CURRENT);
        if (!isNewer(latest, CURRENT)) return;
        if (!mandatory && localStorage.getItem(`update-dismissed-${latest}`)) return;
        showNotice({
          id: `app-update-${latest}`,
          title: mandatory
            ? `Cần cập nhật TruyệnAudio (${latest})`
            : `Có bản cập nhật mới (${latest})`,
          message: `Bạn đang dùng bản ${CURRENT}${v.download_url ? " — tải bản mới để cập nhật." : "."}${v.sha256 ? ` Mã kiểm tra: ${v.sha256.slice(0, 12)}…` : ""}`,
          actionLabel: v.download_url ? "Tải về" : undefined,
          onAction: v.download_url
            ? () => window.open(v.download_url!, "_blank", "noopener,noreferrer")
            : undefined,
          onDismiss: mandatory
            ? undefined
            : () => localStorage.setItem(`update-dismissed-${latest}`, "1"),
          durationMs: null,
        });
      } catch {
        // Offline or backend down — try again next app start.
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [showNotice]);

  return null;
}
