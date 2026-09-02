"use client";

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-accent text-ink hover:bg-accent-dim",
  secondary:
    "border border-hairline bg-raised text-text hover:bg-raised-hi",
  danger: "bg-vermillion text-white hover:bg-vermillion-dim",
  ghost: "bg-transparent text-text-dim hover:bg-raised",
};

export interface ActionButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: ReactNode;
}

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(
  function ActionButton(
    {
      variant = "primary",
      loading = false,
      icon,
      className,
      children,
      disabled,
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={classes(
          "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold",
          "transition-[color,background-color,border-color,opacity,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
          "active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink",
          variantClasses[variant],
          className,
        )}
      >
        {loading ? (
          <span
            className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          icon
        )}
        {children}
      </button>
    );
  },
);

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "default" | "large";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { label, size = "default", className, children, type = "button", ...props },
    ref,
  ) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        aria-label={label}
        title={props.title ?? label}
        className={classes(
          "inline-flex shrink-0 items-center justify-center rounded-full text-text-dim hover:bg-raised-hi hover:text-text",
          "transition-[color,background-color,opacity,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
          "active:scale-[0.96] disabled:pointer-events-none disabled:opacity-45 motion-reduce:transition-none motion-reduce:active:scale-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink",
          size === "large" ? "size-12" : "size-11",
          className,
        )}
      >
        {children}
      </button>
    );
  },
);

