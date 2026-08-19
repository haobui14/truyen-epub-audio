/**
 * The reader is an immersive surface: the app's tab bar hides there, the mini
 * player collapses to a quiet strip, and the chapter text gets the screen.
 *
 * Shared by BottomNav, MiniPlayer and PlayerPadding so the three fixed layers
 * at the bottom of the viewport agree on when the reader owns that space —
 * they used to stack up to ~122px of chrome over a page meant for reading.
 *
 * Covers both routes that render the reader: the Capacitor-friendly
 * `/read?id=…` wrapper and the web `/books/<id>/read` path.
 */
export function isReaderRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return (
    pathname === "/read" ||
    pathname === "/read/" ||
    /^\/books\/[^/]+\/read\/?$/.test(pathname)
  );
}
