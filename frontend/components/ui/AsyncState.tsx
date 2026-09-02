import type { ReactNode } from "react";
import { ActionButton } from "./Button";

export function AsyncState({
  kind,
  title,
  message,
  actionLabel = "Thử lại",
  onAction,
  compact = false,
}: {
  kind: "loading" | "empty" | "error";
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  if (kind === "loading") {
    return (
      <div
        className={compact ? "space-y-2" : "space-y-3 py-5"}
        role="status"
        aria-label={title}
      >
        <span className="sr-only">{title}</span>
        {[0, 1, 2].map((item) => (
          <div
            key={item}
            className="h-16 animate-pulse rounded-xl bg-raised motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  }

  return (
    <section
      className={
        compact
          ? "rounded-xl border border-hairline-soft bg-surface p-4"
          : "mx-auto flex max-w-md flex-col items-center rounded-2xl border border-hairline-soft bg-surface px-6 py-10 text-center"
      }
      role={kind === "error" ? "alert" : "status"}
    >
      <h2 className="font-display text-xl font-semibold text-text">{title}</h2>
      {message && <p className="mt-1 text-sm leading-relaxed text-text-mute">{message}</p>}
      {onAction && (
        <ActionButton
          variant="secondary"
          onClick={onAction}
          className="mt-4"
        >
          {actionLabel}
        </ActionButton>
      )}
    </section>
  );
}

export function CachedContentNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-gold/25 bg-gold/10 px-3 py-2 text-xs leading-relaxed text-gold">
      {children}
    </div>
  );
}

