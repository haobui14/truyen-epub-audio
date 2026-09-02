"use client";
import { useEffect, useId, useRef } from "react";
import { useOverlayManager } from "@/context/OverlayContext";
import { ActionButton } from "./Button";

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
  const id = `confirm-${useId()}`;
  const { register } = useOverlayManager();

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return register({ id, dismiss: onCancel });
  }, [id, onCancel, open, register]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      onClose={onCancel}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      className="fixed inset-0 z-50 bg-transparent backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <div
          className="bg-surface dark:bg-raised rounded-2xl shadow-2xl border border-hairline-soft dark:border-hairline w-full max-w-sm animate-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-5">
            <div className="flex items-start gap-3">
              {variant === "danger" && (
                <div className="w-10 h-10 rounded-full bg-vermillion/15 dark:bg-vermillion/50 flex items-center justify-center shrink-0">
                  <svg
                    className="w-5 h-5 text-vermillion dark:text-vermillion"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h3 id={`${id}-title`} className="text-base font-semibold text-text dark:text-text">
                  {title}
                </h3>
                <p id={`${id}-message`} className="text-sm text-text-mute dark:text-text-mute mt-1">
                  {message}
                </p>
              </div>
            </div>
          </div>
          <div className="flex gap-2 px-5 pb-5">
            <ActionButton
              onClick={onCancel}
              variant="secondary"
              className="flex-1"
            >
              {cancelLabel}
            </ActionButton>
            <ActionButton
              onClick={onConfirm}
              variant={variant === "danger" ? "danger" : "primary"}
              className="flex-1"
            >
              {confirmLabel}
            </ActionButton>
          </div>
        </div>
      </div>
    </dialog>
  );
}
