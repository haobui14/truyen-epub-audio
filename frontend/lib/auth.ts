import { isNativePlatform } from "@/lib/capacitor";
import { getTtsBridge } from "@/lib/backgroundLock";

const TOKEN_KEY = "auth_token";
const USER_KEY = "auth_user";
const REFRESH_TOKEN_KEY = "auth_refresh_token";

// True while setAuth() is mid-write. hydrateAuthFromNative() must not overwrite
// localStorage from (possibly stale) SharedPreferences during this window: a
// queued visibilitychange firing hydrate in the middle of a token rotation
// would otherwise clobber the just-set fresh tokens with the old ones.
let _setAuthInFlight = false;
let _nativeToken: string | null = null;
let _nativeRefreshToken: string | null = null;
let _nativeUser: AuthUser | null = null;

export interface AuthUser {
  user_id: string;
  email: string;
  role?: string;
  display_name?: string;
  avatar_base64?: string;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  if (isNativePlatform()) return _nativeToken;
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  if (isNativePlatform()) return _nativeRefreshToken;
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function getUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  if (isNativePlatform()) return _nativeUser;
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
    const effectiveRefreshToken = refreshToken ?? getRefreshToken() ?? undefined;
    // Persist to the Keystore-backed native blob first. On Android it is the
    // durable copy that survives a process kill; decrypted values stay only in
    // module memory. If the OS killed the process mid-write, the next cold
    // start must never hydrate the old refresh token. (The
    // backend now keeps rotated tokens valid until expiry rather than revoking
    // on use, so such a replay no longer logs the user out — but keeping the
    // durable copy authoritative-and-current is the right invariant regardless.)
    await persistAuthToNative(token, user, effectiveRefreshToken);
    if (isNativePlatform() && getTtsBridge()?.saveSecureAuth) {
      _nativeToken = token;
      _nativeUser = user;
      if (effectiveRefreshToken) _nativeRefreshToken = effectiveRefreshToken;
      // Tokens must never remain in the WebView's durable storage.
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    } else {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      if (effectiveRefreshToken)
        localStorage.setItem(REFRESH_TOKEN_KEY, effectiveRefreshToken);
    }
    window.dispatchEvent(new Event("auth-change"));
  } finally {
    _setAuthInFlight = false;
  }
}

export function clearAuth() {
  _nativeToken = null;
  _nativeRefreshToken = null;
  _nativeUser = null;
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

// True on web immediately and on native after the encrypted blob is hydrated.
// Admin-guarded pages must wait for this before checking isAdmin() so they
// don't redirect on Android due to empty localStorage before hydration.
let _authReady: boolean = typeof window !== "undefined" && !isNativePlatform();

export function isAuthReady(): boolean {
  return _authReady;
}

// ── Native persistence (Android Keystore; Preferences is migration-only) ──

async function persistAuthToNative(
  token: string,
  user: AuthUser,
  refreshToken?: string,
): Promise<void> {
  if (!isNativePlatform()) return;
  const bridge = getTtsBridge();
  if (bridge?.saveSecureAuth) {
    const saved = bridge.saveSecureAuth(
      JSON.stringify({ token, user, refreshToken: refreshToken ?? "" }),
    );
    if (!saved) throw new Error("secure-auth-write-failed");
    return;
  }
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
  const bridge = getTtsBridge();
  if (bridge?.clearSecureAuth) bridge.clearSecureAuth();
  import("@capacitor/preferences")
    .then(({ Preferences }) => {
      Preferences.remove({ key: TOKEN_KEY });
      Preferences.remove({ key: USER_KEY });
      Preferences.remove({ key: REFRESH_TOKEN_KEY });
    })
    .catch(() => {});
}

/**
 * On native platforms, decrypt auth into module memory and erase legacy copies.
 * Call once on app startup before rendering auth-dependent components.
 */
export async function hydrateAuthFromNative(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const bridge = getTtsBridge();
    if (bridge?.loadSecureAuth) {
      let raw = bridge.loadSecureAuth();
      if (!raw) raw = bridge.migrateLegacyAuth?.() ?? "";

      // One-time localStorage migration for builds that predate the native
      // encrypted store. Save first; delete only after the native commit.
      if (!raw) {
        const legacyToken = localStorage.getItem(TOKEN_KEY);
        const legacyUser = localStorage.getItem(USER_KEY);
        const legacyRefresh = localStorage.getItem(REFRESH_TOKEN_KEY) ?? "";
        if (legacyToken && legacyUser) {
          const candidate = JSON.stringify({
            token: legacyToken,
            user: JSON.parse(legacyUser),
            refreshToken: legacyRefresh,
          });
          if (bridge.saveSecureAuth?.(candidate)) raw = candidate;
        }
      }

      if (raw && !_setAuthInFlight) {
        const parsed = JSON.parse(raw) as {
          token?: string;
          refreshToken?: string;
          user?: AuthUser | string;
        };
        _nativeToken = parsed.token ?? null;
        _nativeRefreshToken = parsed.refreshToken || null;
        _nativeUser =
          typeof parsed.user === "string"
            ? JSON.parse(parsed.user)
            : (parsed.user ?? null);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
        const { Preferences } = await import("@capacitor/preferences");
        await Promise.all([
          Preferences.remove({ key: TOKEN_KEY }),
          Preferences.remove({ key: USER_KEY }),
          Preferences.remove({ key: REFRESH_TOKEN_KEY }),
        ]);
        return;
      }
    }

    // Backward compatibility for an old APK bridge. This path disappears once
    // every private device has received the release-signed migration build.
    const { Preferences } = await import("@capacitor/preferences");
    const { value: token } = await Preferences.get({ key: TOKEN_KEY });
    const { value: user } = await Preferences.get({ key: USER_KEY });
    const { value: refreshToken } = await Preferences.get({
      key: REFRESH_TOKEN_KEY,
    });
    // Hydrate memory from old native preferences only when no setAuth() is
    // mid-write. Overwriting unconditionally used to clobber a fresher rotation
    // when a queued visibilitychange fired hydrate during setAuth(), replaying
    // the old refresh token. A surviving WebView keeps its localStorage, so a
    // present token there is never staler than SharedPreferences.
    if (!_setAuthInFlight) {
      _nativeToken = token;
      _nativeUser = user ? JSON.parse(user) : null;
      _nativeRefreshToken = refreshToken;
    }
  } catch {
    // Plugin not available — ignore
  } finally {
    _authReady = true;
  }
}
