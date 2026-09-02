import { beforeEach, describe, expect, it, vi } from "vitest";

const keepAwake = vi.fn().mockResolvedValue(undefined);
const allowSleep = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/capacitor", () => ({ isNativePlatform: () => true }));
vi.mock("@capacitor-community/keep-awake", () => ({
  KeepAwake: { keepAwake, allowSleep },
}));

import { acquireBackgroundLock, releaseBackgroundLock } from "./backgroundLock";

type BridgeMock = {
  getNotificationPermissionStatus: () => "denied";
  requestNotificationPermission: ReturnType<typeof vi.fn>;
  startService: ReturnType<typeof vi.fn>;
  stopService: ReturnType<typeof vi.fn>;
};

describe("native background bridge", () => {
  let bridge: BridgeMock;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    bridge = {
      getNotificationPermissionStatus: () => "denied",
      requestNotificationPermission: vi.fn(),
      startService: vi.fn(),
      stopService: vi.fn(),
    };
    (
      window as Window & { TtsBridge?: Partial<BridgeMock> }
    ).TtsBridge = bridge;
  });

  it("starts foreground playback without requesting an unexplained permission", async () => {
    await acquireBackgroundLock();
    expect(bridge.requestNotificationPermission).not.toHaveBeenCalled();
    expect(bridge.startService).toHaveBeenCalledOnce();
    expect(keepAwake).toHaveBeenCalledOnce();
  });

  it("requests after feature context and releases both native resources", async () => {
    localStorage.setItem("notification-permission-context-shown", "1");
    await acquireBackgroundLock();
    expect(bridge.requestNotificationPermission).toHaveBeenCalledOnce();

    await releaseBackgroundLock();
    expect(bridge.stopService).toHaveBeenCalledOnce();
    expect(allowSleep).toHaveBeenCalledOnce();
  });
});
