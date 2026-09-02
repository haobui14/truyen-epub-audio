"use client";

import { useEffect } from "react";
import { useNotices } from "@/context/NoticeContext";
import {
  NATIVE_BRIDGE_CAPABILITY_VERSION,
  getNativeBridgeCapabilityVersion,
} from "@/lib/backgroundLock";
import { isNativePlatform } from "@/lib/capacitor";

export function BridgeCompatibilityNotice() {
  const { showNotice } = useNotices();

  useEffect(() => {
    if (!isNativePlatform()) return;
    const actual = getNativeBridgeCapabilityVersion();
    if (actual >= NATIVE_BRIDGE_CAPABILITY_VERSION) return;
    showNotice({
      id: "native-bridge-mismatch",
      title: "Ứng dụng cần được cập nhật",
      message: `Giao diện yêu cầu cầu nối ${NATIVE_BRIDGE_CAPABILITY_VERSION}, nhưng Android đang cung cấp ${actual}. Các tính năng native mới đã được tắt an toàn.`,
      tone: "warning",
      durationMs: null,
    });
  }, [showNotice]);

  return null;
}

