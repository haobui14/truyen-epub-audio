/**
 * Global client-error reporter.
 *
 * Uncaught errors and unhandled promise rejections are POSTed to
 * /api/client-log so device-side failures (Android WebView especially) stop
 * vanishing without a trace. Fire-and-forget: reporting must never affect the
 * app, so every path swallows its own failures.
 */
import { API_URL } from "./constants";
import { getToken } from "./auth";
import { isNativePlatform } from "./capacitor";

const MAX_REPORTS_PER_SESSION = 10;
const MAX_BREADCRUMBS_PER_SESSION = 30;

// Known-benign noise that would burn the session budget for nothing.
const IGNORED = [
  "ResizeObserver loop", // browser quirk, not an app error
  "Script error.", // opaque cross-origin errors carry no information
];

let sent = 0;
let breadcrumbsSent = 0;
const seen = new Set<string>();
let installed = false;
let runtime = "";

function redactSensitive(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/([?&](?:access_?token|refresh_?token|token)=)[^&#\s]+/gi, "$1[redacted]");
}

function runtimeContext(): string {
  if (runtime || !isNativePlatform()) return runtime;
  try {
    const raw = (
      window as Window & { TtsBridge?: { getRuntimeInfo?(): string } }
    ).TtsBridge?.getRuntimeInfo?.();
    if (raw) runtime = redactSensitive(raw).slice(0, 800);
  } catch {}
  return runtime;
}

function platform(): string {
  if (isNativePlatform()) return "android";
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(display-mode: standalone)").matches
  )
    return "pwa";
  return "web";
}

export function reportClientError(message: string, stack?: string): void {
  try {
    const base = redactSensitive((message || "").trim());
    const context = runtimeContext();
    const msg = `${base}${context ? ` | runtime=${context}` : ""}`.slice(0, 2000);
    if (!msg) return;
    if (IGNORED.some((p) => msg.includes(p))) return;
    // One report per distinct message per session — a render-loop error would
    // otherwise fire hundreds of identical rows.
    if (seen.has(msg) || sent >= MAX_REPORTS_PER_SESSION) return;
    seen.add(msg);
    sent += 1;

    const token = getToken();
    fetch(`${API_URL}/api/client-log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        message: msg,
        stack: stack ? redactSensitive(stack).slice(0, 4000) : undefined,
        url: window.location.pathname + window.location.search,
        platform: platform(),
        app_version: process.env.NEXT_PUBLIC_APP_VERSION,
      }),
      // Let the report finish even if the page is being torn down.
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Reporting must never throw into the app.
  }
}

/** Privacy-safe, content-free trail for playback/download failure diagnosis. */
export function reportClientBreadcrumb(
  category: "playback" | "download" | "lifecycle",
  event: string,
  stage: string,
  details: Record<string, string | number | boolean | null | undefined> = {},
): void {
  if (breadcrumbsSent >= MAX_BREADCRUMBS_PER_SESSION) return;
  const safeDetails = Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !/(token|text|content|chapter_title|book_title)/i.test(key))
      .map(([key, value]) => [key.slice(0, 40), value]),
  );
  breadcrumbsSent += 1;
  reportClientError(
    `breadcrumb category=${category} event=${event.slice(0, 80)} stage=${stage.slice(0, 80)} details=${JSON.stringify(safeDetails)}`,
  );
}

/** Install window-level handlers. Idempotent; call once from Providers. */
export function initErrorReporter(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  if (isNativePlatform()) {
    runtimeContext();
    try {
      const crash = (
        window as Window & {
          TtsBridge?: { consumeRecoveredCrash?(): string };
        }
      ).TtsBridge?.consumeRecoveredCrash?.();
      if (crash) {
        reportClientError(
          "native crash recovered on next launch; stage=previous-process",
          crash,
        );
      }
    } catch {}
  }

  window.addEventListener("error", (event) => {
    reportClientError(
      event.message || String(event.error || "unknown error"),
      event.error?.stack,
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    reportClientError(
      reason?.message || String(reason ?? "unhandled rejection"),
      reason?.stack,
    );
  });
}
