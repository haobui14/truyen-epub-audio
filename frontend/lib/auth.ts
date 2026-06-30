import { isNativePlatform } from "@/lib/capacitor";

const TOKEN_KEY = "auth_token";
const USER_KEY = "auth_user";
const REFRESH_TOKEN_KEY = "auth_refresh_token";

// True while setAuth() is mid-write. hydrateAuthFromNative() must not overwrite
// localStorage from (possibly stale) SharedPreferences during this window: a
// queued visibilitychange firing hydrate in the middle of a token rotation
// would otherwise clobber the just-set fresh tokens with the old ones.
let _setAuthInFlight = false;

export interface AuthUser {
  user_id: string;
  email: string;
  role?: string;
  display_name?: string;
  avatar_base64?: string;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function getUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setAuth(
  token: string,
  user: AuthUser,
  refreshToken?: string,
): Promise<void> {
  _setAuthInFlight = true;
  try {
    // Persist to native SharedPreferences FIRST, then localStorage. On Android,
    // SharedPreferences is the durable copy that survives a process kill — the
    // killed WebView's localStorage is gone on next launch. If we wrote
    // localStorage first and the OS killed the process mid-write, the next cold
    // start would hydrate the OLD refresh token from SharedPreferences. (The
    // backend now keeps rotated tokens valid until expiry rather than revoking
    // on use, so such a replay no longer logs the user out — but keeping the
    // durable copy authoritative-and-current is the right invariant regardless.)
    await persistAuthToNative(token, user, refreshToken);
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    window.dispatchEvent(new Event("auth-change"));
  } finally {
    _setAuthInFlight = false;
  }
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  clearNativeAuth();
  window.dispatchEvent(new Event("auth-change"));
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function isAdmin(): boolean {
  return getUser()?.role === "admin";
}

// True on web (localStorage is populated immediately) and on native after
// hydrateAuthFromNative() has copied SharedPreferences → localStorage.
// Admin-guarded pages must wait for this before checking isAdmin() so they
// don't redirect on Android due to empty localStorage before hydration.
let _authReady: boolean = typeof window !== "undefined" && !isNativePlatform();

export function isAuthReady(): boolean {
  return _authReady;
}

// ── Native persistence (Android SharedPreferences via @capacitor/preferences) ──

async function persistAuthToNative(
  token: string,
  user: AuthUser,
  refreshToken?: string,
): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { Preferences } = await import("@capacitor/preferences");
    await Preferences.set({ key: TOKEN_KEY, value: token });
    await Preferences.set({ key: USER_KEY, value: JSON.stringify(user) });
    if (refreshToken)
      await Preferences.set({ key: REFRESH_TOKEN_KEY, value: refreshToken });
  } catch {}
}

function clearNativeAuth() {
  if (!isNativePlatform()) return;
  import("@capacitor/preferences")
    .then(({ Preferences }) => {
      Preferences.remove({ key: TOKEN_KEY });
      Preferences.remove({ key: USER_KEY });
      Preferences.remove({ key: REFRESH_TOKEN_KEY });
    })
    .catch(() => {});
}

/**
 * On native platforms, restore auth from SharedPreferences into localStorage.
 * Call once on app startup before rendering auth-dependent components.
 */
export async function hydrateAuthFromNative(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { Preferences } = await import("@capacitor/preferences");
    const { value: token } = await Preferences.get({ key: TOKEN_KEY });
    const { value: user } = await Preferences.get({ key: USER_KEY });
    const { value: refreshToken } = await Preferences.get({
      key: REFRESH_TOKEN_KEY,
    });
    // Hydrate localStorage from native preferences ONLY when localStorage is
    // empty (the cold-start case this exists for) and no setAuth() is mid-write.
    // Overwriting unconditionally used to clobber a fresher in-flight rotation
    // when a queued visibilitychange fired hydrate during setAuth(), replaying
    // the old refresh token. A surviving WebView keeps its localStorage, so a
    // present token there is never staler than SharedPreferences.
    if (!_setAuthInFlight && !localStorage.getItem(TOKEN_KEY)) {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      if (user) localStorage.setItem(USER_KEY, user);
      if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    }
  } catch {
    // Plugin not available — ignore
  } finally {
    _authReady = true;
  }
}
