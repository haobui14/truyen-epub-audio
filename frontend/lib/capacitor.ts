import { Capacitor } from "@capacitor/core";

/** True when running inside a Capacitor native shell (Android/iOS) */
export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Returns 'android', 'ios', or 'web' */
export function getPlatform(): string {
  try {
    return Capacitor.getPlatform();
  } catch {
    return "web";
  }
}
