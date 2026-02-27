interface BadgeProps {
  status: string;
}

const STATUS_STYLES: Record<string, string> = {
  ready: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
  converting: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800",
  parsing: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  parsed: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  pending: "bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-gray-200 dark:border-gray-700",
  error: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800",
};

const STATUS_DOT: Record<string, string> = {
  ready: "bg-emerald-500",
  converting: "bg-amber-500 animate-pulse",
  parsing: "bg-blue-500 animate-pulse",
  parsed: "bg-blue-500",
  pending: "bg-gray-400",
  error: "bg-red-500",
};

const STATUS_LABELS: Record<string, string> = {
  ready: "Sẵn sàng",
  converting: "Đang xử lý",
  parsing: "Đang phân tích",
  parsed: "Đã phân tích",
  pending: "Chờ",
  error: "Lỗi",
};

export function Badge({ status }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
        STATUS_STYLES[status] ?? "bg-gray-50 text-gray-600 border-gray-200"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] ?? "bg-gray-400"}`} />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
