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

  const report = async (
    result: { current: ReturnType<typeof useProgressSync> },
    value: number,
  ) => {
    act(() => result.current.reportProgress(value, 100));
    await act(async () => vi.advanceTimersByTime(10_000));
    await settle();
  };

  it("saves locally on every report but writes the server once per chapter view", async () => {
    const { result } = render();
    for (let i = 1; i <= 6; i++) await report(result, i);

    expect(saveLocalProgress).toHaveBeenCalledTimes(6);
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({ chapter_id: "c1", progress_value: 1 }),
    );

    // No timer-driven writes, however long playback continues.
    await act(async () => vi.advanceTimersByTime(10 * 60_000));
    await settle();
    expect(saveProgress).toHaveBeenCalledTimes(1);
  });

  it("flush() (pause) sends the latest position", async () => {
    const { result } = render();
    await report(result, 1);
    act(() => result.current.reportProgress(7, 100));
    act(() => result.current.flush());
    await settle();
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ chapter_id: "c1", progress_value: 7 }),
    );
  });

  it("chapter change sends the old chapter's last position, then the new chapter's view", async () => {
    const { result, rerender } = render();
    await report(result, 1);
    act(() => result.current.reportProgress(9, 100));

    rerender({ chapterId: "c2" });
    await settle();
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ chapter_id: "c1", progress_value: 9 }),
    );

    // Same value as the old chapter's last save still counts as a new view.
    await report(result, 9);
    expect(saveProgress).toHaveBeenCalledTimes(3);
    expect(saveProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ chapter_id: "c2", progress_value: 9 }),
    );
  });

  it("writes the server when the page is hidden", async () => {
    const { result } = render();
    await report(result, 1);
    act(() => result.current.reportProgress(2, 100));

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress).toHaveBeenLastCalledWith(expect.objectContaining({ progress_value: 2 }));
  });

  it("does nothing when nothing changed since the last save", async () => {
    const { result } = render();
    await report(result, 1);
    act(() => result.current.flush());
    await settle();
    expect(saveProgress).toHaveBeenCalledTimes(1);
  });
});
