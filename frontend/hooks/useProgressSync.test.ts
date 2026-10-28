import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveProgress = vi.fn(() => Promise.resolve({}));
const saveLocalProgress = vi.fn();

vi.mock("@/lib/auth", () => ({ isLoggedIn: () => true }));
vi.mock("@/lib/api", () => ({ api: { saveProgress: (...a: unknown[]) => saveProgress(...(a as [])) } }));
vi.mock("@/lib/progressQueue", () => ({
  enqueueProgress: vi.fn(),
  saveLocalProgress: (...a: unknown[]) => saveLocalProgress(...(a as [])),
  saveLocalBookProgress: vi.fn(),
  isLatestChapterForBook: () => Promise.resolve(true),
}));

import { useProgressSync } from "./useProgressSync";

// Lets the isLatestChapterForBook promise chain reach api.saveProgress.
const settle = () => act(async () => {});

describe("useProgressSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveProgress.mockClear();
    saveLocalProgress.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const render = () =>
    renderHook((p: { chapterId: string }) =>
      useProgressSync({ bookId: "b1", chapterId: p.chapterId, chapterIndex: 3 }),
    { initialProps: { chapterId: "c1" } });

  it("saves locally on every debounce but hits the server at most every 30s", async () => {
    const { result } = render();

    // Steady playback: a chunk every 10s for 60s.
    for (let i = 1; i <= 6; i++) {
      act(() => result.current.reportProgress(i, 100));
      await act(async () => vi.advanceTimersByTime(10_000));
      await settle();
    }

    expect(saveLocalProgress).toHaveBeenCalledTimes(6);
    // First write immediately, then one trailing write per 30s window.
    expect(saveProgress.mock.calls.length).toBeLessThanOrEqual(3);
    expect(saveProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("always delivers the latest position via the trailing write", async () => {
    const { result } = render();
    act(() => result.current.reportProgress(1, 100));
    await act(async () => vi.advanceTimersByTime(5_000));
    await settle();
    act(() => result.current.reportProgress(2, 100));
    await act(async () => vi.advanceTimersByTime(5_000));
    await settle();
    expect(saveProgress).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(30_000));
    await settle();
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ chapter_id: "c1", progress_value: 2 }),
    );
  });

  it("writes the old chapter immediately on chapter change", async () => {
    const { result, rerender } = render();
    act(() => result.current.reportProgress(1, 100));
    await act(async () => vi.advanceTimersByTime(5_000));
    await settle();
    act(() => result.current.reportProgress(9, 100));

    rerender({ chapterId: "c2" });
    await settle();

    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ chapter_id: "c1", progress_value: 9 }),
    );
  });

  it("flushes to the server when the page is hidden", async () => {
    const { result } = render();
    act(() => result.current.reportProgress(1, 100));
    await act(async () => vi.advanceTimersByTime(5_000));
    await settle();
    act(() => result.current.reportProgress(2, 100));

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress).toHaveBeenLastCalledWith(expect.objectContaining({ progress_value: 2 }));
  });
});
