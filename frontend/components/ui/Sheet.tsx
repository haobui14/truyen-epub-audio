"use client";

import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { useOverlayManager } from "@/context/OverlayContext";
import { IconButton } from "./Button";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  bottomOffset = "var(--sab)",
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  bottomOffset?: string;
}) {
  const generatedId = useId();
  const id = `sheet-${generatedId}`;
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { register, isTop } = useOverlayManager();

  useEffect(() => {
    if (!open) return;
    const restoreFocus = document.activeElement as HTMLElement | null;
    const unregister = register({ id, dismiss: onClose });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      unregister();
      document.body.style.overflow = previousOverflow;
      restoreFocus?.focus?.();
    };
  }, [id, onClose, open, register]);

  useEffect(() => {
    if (!open) return;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !isTop(id)) return;
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, [id, isTop, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70]" role="presentation">
      <button
        type="button"
        className="absolute inset-0 size-full cursor-default bg-black/60 backdrop-blur-[2px]"
        aria-label="Đóng nền"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="animate-sheet-in fixed inset-x-0 mx-auto max-h-[min(80dvh,46rem)] max-w-2xl overflow-hidden rounded-t-2xl border border-b-0 border-hairline bg-surface shadow-[0_-20px_60px_rgba(0,0,0,0.55)]"
        style={{ bottom: bottomOffset }}
      >
        <div className="flex min-h-14 items-center gap-3 border-b border-hairline-soft px-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate font-display text-xl font-semibold text-text">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="text-xs text-text-mute">
                {description}
              </p>
            )}
          </div>
          <IconButton ref={closeRef} label="Đóng" onClick={onClose}>
            <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </IconButton>
        </div>
        <div className="max-h-[calc(min(80dvh,46rem)-3.5rem)] overflow-y-auto overscroll-contain p-4">
          {children}
        </div>
        {footer && <div className="border-t border-hairline-soft p-4">{footer}</div>}
      </div>
    </div>
  );
}
