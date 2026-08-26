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

// Known-benign noise that would burn the session budget for nothing.
const IGNORED = [
  "ResizeObserver loop", // browser quirk, not an app error
  "Script error.", // opaque cross-origin errors carry no information
];

let sent = 0;
const seen = new Set<string>();
let installed = false;

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
    const msg = (message || "").trim().slice(0, 2000);
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
        stack: stack?.slice(0, 4000),
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

/** Install window-level handlers. Idempotent; call once from Providers. */
export function initErrorReporter(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

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
