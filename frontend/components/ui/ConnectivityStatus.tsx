"use client";

import { useConnectivity } from "@/context/ConnectivityContext";

function relativeTime(timestamp: number | null) {
  if (!timestamp) return "chưa đồng bộ";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "vừa đồng bộ";
  if (minutes < 60) return `đồng bộ ${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  return `đồng bộ ${hours} giờ trước`;
}

export function ConnectivityStatus({ cached = false }: { cached?: boolean }) {
  const { online, lastOnlineAt, refresh } = useConnectivity();
  if (online && !cached) return null;

  return (
    <div
      className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
        online
          ? "border-hairline bg-raised text-text-mute"
          : "border-gold/30 bg-gold/10 text-gold"
      }`}
      role="status"
    >
      <span
        className={`size-2 shrink-0 rounded-full ${online ? "bg-text-mute" : "bg-gold"}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        {online ? "Đang hiển thị dữ liệu đã lưu" : `Ngoại tuyến · ${relativeTime(lastOnlineAt)}`}
      </span>
      <button
        type="button"
        onClick={() => void refresh()}
        className="min-h-11 shrink-0 rounded-lg px-2 font-semibold underline underline-offset-2 transition-[opacity,transform] active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
      >
        Thử lại
      </button>
    </div>
  );
}

