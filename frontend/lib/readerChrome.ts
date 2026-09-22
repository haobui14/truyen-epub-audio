import { useSyncExternalStore } from "react";

/**
 * Whether the reader's chrome (top bar, chapter bar, mini player) is hidden.
 *
 * A tap on the text toggles it for immersive reading. It lives outside React
 * state because MiniPlayer is rendered by the app shell, not by the reader,
 * and both have to agree.
 */
let hidden = false;
const listeners = new Set<() => void>();

export function setReaderChromeHidden(next: boolean) {
  if (hidden === next) return;
  hidden = next;
  listeners.forEach((listener) => listener());
}

export function toggleReaderChromeHidden() {
  setReaderChromeHidden(!hidden);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReaderChromeHidden(): boolean {
  return useSyncExternalStore(subscribe, () => hidden, () => false);
}
