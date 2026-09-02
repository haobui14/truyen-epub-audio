"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ActionButton } from "@/components/ui/Button";
import { AsyncState } from "@/components/ui/AsyncState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ConnectivityStatus } from "@/components/ui/ConnectivityStatus";
import {
  getOfflineRepository,
  type OfflineBookState,
} from "@/lib/offlineRepository";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

const statusLabel: Record<OfflineBookState["status"], string> = {
  ready: "Sẵn sàng",
  downloading: "Đang tải",
  partial: "Chưa hoàn tất",
  stale: "Có cập nhật",
  error: "Lỗi",
};

export default function DownloadsPage() {
  const repository = useMemo(() => getOfflineRepository(), []);
  const [books, setBooks] = useState<OfflineBookState[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const states = await repository.listBookStates();
      setBooks(states.sort((a, b) => b.updated_at - a.updated_at));
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        setStorage({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 });
      }
    } catch {
      setLoadError(true);
    }
  }, [repository]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selected = books?.find((book) => book.book_id === removing);
  const downloadedBytes = books?.reduce((sum, book) => sum + book.bytes_total, 0) ?? 0;

  return (
    <div className="mx-auto max-w-2xl">
      <ConnectivityStatus />
      <header className="mb-5 mt-5">
        <Link
          href="/my-books"
          className="inline-flex min-h-11 items-center text-sm font-semibold text-accent"
        >
          ← Truyện của tôi
        </Link>
        <h1 className="font-display text-3xl font-semibold text-text">Tải xuống</h1>
        <p className="mt-1 text-sm text-text-mute">
          Xóa bản tải sẽ không xóa tiến độ đọc hoặc nghe.
        </p>
      </header>

      <section className="mb-5 rounded-2xl border border-hairline bg-surface p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-text-faint">
              Dữ liệu truyện
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-text">
              {formatBytes(downloadedBytes)}
            </p>
          </div>
          {storage && storage.quota > 0 && (
            <p className="text-right text-xs text-text-mute">
              Ứng dụng đang dùng {formatBytes(storage.usage)} / {formatBytes(storage.quota)}
            </p>
          )}
        </div>
      </section>

      {books === null && !loadError && (
        <AsyncState kind="loading" title="Đang kiểm tra bản tải" />
      )}
      {loadError && (
        <AsyncState
          kind="error"
          title="Không thể đọc kho ngoại tuyến"
          onAction={() => void load()}
        />
      )}
      {books?.length === 0 && (
        <AsyncState
          kind="empty"
          title="Chưa tải truyện nào"
          message="Mở chi tiết một truyện và chọn Tải truyện offline."
        />
      )}

      <div className="space-y-3">
        {books?.map((book) => (
          <article
            key={book.book_id}
            className="rounded-2xl border border-hairline-soft bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate font-semibold text-text">{book.book_title}</h2>
                <p className="mt-1 text-xs text-text-mute">
                  {book.completed_chapters}/{book.total_chapters} chương · {formatBytes(book.bytes_total)}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                  book.status === "ready"
                    ? "bg-accent/10 text-accent"
                    : book.status === "downloading"
                      ? "bg-raised text-text-mute"
                      : "bg-gold/10 text-gold"
                }`}
              >
                {statusLabel[book.status]}
              </span>
            </div>
            {book.error_message && (
              <p className="mt-2 text-xs leading-relaxed text-gold">{book.error_message}</p>
            )}
            <div className="mt-3 flex gap-2">
              <Link
                href={`/books/${book.book_id}`}
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-hairline px-3 text-sm font-semibold text-accent transition-[background-color,transform] hover:bg-accent/10 active:scale-[0.96]"
              >
                {book.status === "ready" ? "Kiểm tra cập nhật" : "Tiếp tục tải"}
              </Link>
              <ActionButton variant="ghost" onClick={() => setRemoving(book.book_id)}>
                Xóa
              </ActionButton>
            </div>
          </article>
        ))}
      </div>

      <ConfirmDialog
        open={!!selected}
        title="Xóa bản tải?"
        message={`Nội dung ngoại tuyến của “${selected?.book_title ?? "truyện"}” sẽ bị xóa. Tiến độ vẫn được giữ lại.`}
        confirmLabel="Xóa bản tải"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!selected) return;
          void repository.removeBook(selected.book_id).then(() => {
            setRemoving(null);
            void load();
          });
        }}
      />
    </div>
  );
}
