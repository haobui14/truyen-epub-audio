"use client";
import { useEffect, useRef } from "react";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Xóa",
  cancelLabel = "Hủy",
  onConfirm,
  onCancel,
  variant = "danger",
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "danger" | "default";
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      onClose={onCancel}
      className="fixed inset-0 z-50 bg-transparent backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <div
          className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-sm animate-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-5">
            <div className="flex items-start gap-3">
              {variant === "danger" && (
                <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-950/50 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{message}</p>
              </div>
            </div>
          </div>
          <div className="flex gap-2 px-5 pb-5">
            <button
              onClick={onCancel}
              className="flex-1 px-4 py-2.5 text-sm font-medium rounded-xl bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              {cancelLabel}
            </button>
            <button
              onClick={onConfirm}
              className={`flex-1 px-4 py-2.5 text-sm font-semibold rounded-xl transition-colors ${
                variant === "danger"
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white"
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
