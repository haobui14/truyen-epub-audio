import { expect, test, type Page } from "@playwright/test";
import type { MyBookProgressEntry } from "../types";

async function openMyBooks(page: Page, failure?: "save" | "no-chapters") {
  const firstChapter = { id: "chapter-1", chapter_index: 0, title: "Chương 1" };
  const previousChapter = { id: "chapter-8", chapter_index: 7, title: "Chương 8" };
  let entries: MyBookProgressEntry[] = [
    {
      book: { id: "book-1", title: "Truyện đọc lại", total_chapters: 10 },
      chapter: previousChapter,
      progress_value: 75,
      total_value: 100,
      updated_at: "2026-10-01T00:00:00Z",
    },
    {
      book: { id: "book-2", title: "Truyện khác", total_chapters: 5 },
      chapter: { id: "other-chapter", chapter_index: 2, title: "Chương khác" },
      progress_value: 30,
      total_value: 100,
      updated_at: "2026-10-01T00:00:00Z",
    },
  ];
  const writes: Array<{ book_id: string; chapter_id: string; progress_value: number; total_value?: number }> = [];
  let offline = false;

  await page.addInitScript(() => {
    localStorage.setItem("auth_token", "my-books-test-token");
    localStorage.setItem("auth_user", JSON.stringify({
      user_id: "user-1",
      email: "reader@example.com",
    }));
  });
  await page.route("**/api/**", async (route) => {
    if (offline) return route.abort();
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "GET, PUT, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers });
    }
    if (path === "/api/progress/my-books") {
      return route.fulfill({ headers, json: entries });
    }
    if (path === "/api/books/book-1/chapters") {
      expect(new URL(request.url()).searchParams.get("page_size")).toBe("1");
      return route.fulfill({
        headers,
        json: { items: failure === "no-chapters" ? [] : [firstChapter] },
      });
    }
    if (path === "/api/progress" && request.method() === "PUT") {
      const data = request.postDataJSON();
      writes.push(data);
      if (failure === "save") {
        return route.fulfill({ status: 500, headers, json: { detail: "Failed" } });
      }
      const updated_at = new Date().toISOString();
      entries = entries.map((entry) => entry.book.id === data.book_id
        ? {
          ...entry,
          chapter: data.chapter_id === firstChapter.id ? firstChapter
            : data.chapter_id === previousChapter.id ? previousChapter : entry.chapter,
          progress_value: data.progress_value,
          total_value: data.total_value,
          updated_at,
        }
        : entry);
      return route.fulfill({ headers, json: { ...data, updated_at } });
    }
    if (path === "/api/settings") {
      return route.fulfill({ headers, json: { playback_rate: 1, playback_pitch: 1 } });
    }
    return route.fulfill({ status: 404, headers, json: { detail: "Not mocked" } });
  });
  await page.goto("/my-books", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Truyện đọc lại", exact: true })).toBeVisible();

  // Seed old chapter positions and pending syncs after startup's queue flush.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("truyen-audio-offline");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["progress-store", "progress-queue"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const storeName of ["progress-store", "progress-queue"]) {
        const store = tx.objectStore(storeName);
        for (const chapter of ["chapter-1", "chapter-8"]) {
          store.put({ id: `book-1:${chapter}`, book_id: "book-1", chapter_id: chapter, progress_value: 75 });
        }
        store.put({ id: "book-2:other-chapter", book_id: "book-2", chapter_id: "other-chapter", progress_value: 30 });
      }
      tx.objectStore("progress-store").put({
        id: "book:book-1", book_id: "book-1", chapter_id: "chapter-8", chapter_index: 7, progress_value: 75,
      });
    });
    db.close();
    localStorage.setItem("listen-chapter:book-1", "chapter-8");
  });
  return { writes, goOffline: () => { offline = true; } };
}

async function readDeviceProgress(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("truyen-audio-offline");
      request.onsuccess = () => resolve(request.result);
    });
    const readAll = (storeName: string) => new Promise<Array<Record<string, unknown>>>((resolve) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
    });
    const [local, queued] = await Promise.all([readAll("progress-store"), readAll("progress-queue")]);
    db.close();
    return { local, queued, listenChapter: localStorage.getItem("listen-chapter:book-1") };
  });
}

test("reset restarts at chapter 1 and survives an offline reload", async ({ page }) => {
  const { writes, goOffline } = await openMyBooks(page);
  const button = page.getByRole("button", { name: "Xóa tiến độ truyện Truyện đọc lại", exact: true });
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await button.click();
  await expect(page.getByRole("status").filter({ hasText: "Đã đặt lại" })).toBeVisible();
  expect(writes).toEqual([{ book_id: "book-1", chapter_id: "chapter-1", progress_value: 0 }]);
  await expect(page.getByRole("link", { name: "Đọc tiếp", exact: true }).first()).toHaveAttribute("href", "/read?id=book-1&chapter=chapter-1");
  await expect(page.getByRole("link", { name: "Nghe tiếp", exact: true }).first()).toHaveAttribute("href", "/listen?id=book-1&chapter=chapter-1");

  const device = await readDeviceProgress(page);
  expect(device.local.filter((row) => row.book_id === "book-1")).toHaveLength(2);
  expect(device.local.find((row) => row.id === "book:book-1")).toMatchObject({ chapter_id: "chapter-1", chapter_index: 0, progress_value: 0 });
  expect(device.local.find((row) => row.id === "book-1:chapter-1")).toMatchObject({ progress_value: 0 });
  expect(device.queued.filter((row) => row.book_id === "book-1")).toEqual([]);
  expect(device.queued.find((row) => row.book_id === "book-2")).toMatchObject({ progress_value: 30 });
  expect(device.local.find((row) => row.book_id === "book-2")).toMatchObject({ progress_value: 30 });
  expect(device.listenChapter).toBe("chapter-1");

  goOffline();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: "Đọc tiếp", exact: true }).first()).toHaveAttribute("href", "/read?id=book-1&chapter=chapter-1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("reset wins over an offline upload already in flight", async ({ page }) => {
  const { writes } = await openMyBooks(page);
  let uploadStarted!: () => void;
  const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
  const finished = page.waitForResponse((response) => {
    const request = response.request();
    return new URL(request.url()).pathname === "/api/progress"
      && request.method() === "PUT"
      && request.postDataJSON().chapter_id === "chapter-8";
  });
  let releaseUpload!: () => void;
  const released = new Promise<void>((resolve) => { releaseUpload = resolve; });

  await page.route("**/api/progress", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT" || request.postDataJSON().chapter_id !== "chapter-8") {
      return route.fallback();
    }
    uploadStarted();
    await released;
    await route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await started;

  // Model an older upload completing while the reset is being saved.
  const releaseTimer = setTimeout(releaseUpload, 500);
  try {
    await page.getByRole("button", { name: "Xóa tiến độ truyện Truyện đọc lại", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Đã đặt lại" })).toBeVisible();
    await finished;
    const bookWrites = writes.filter((value) => value.book_id === "book-1");
    expect(bookWrites.at(-1)).toEqual({ book_id: "book-1", chapter_id: "chapter-1", progress_value: 0 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("link", { name: "Đọc tiếp", exact: true }).first()).toHaveAttribute("href", "/read?id=book-1&chapter=chapter-1");
  } finally {
    clearTimeout(releaseTimer);
    releaseUpload();
  }
});

test("connectivity uploads resume after reset without replaying old progress", async ({ page }) => {
  const { writes } = await openMyBooks(page);
  let resetStarted!: () => void;
  const started = new Promise<void>((resolve) => { resetStarted = resolve; });
  let releaseReset!: () => void;
  const released = new Promise<void>((resolve) => { releaseReset = resolve; });

  await page.route("**/api/progress", async (route) => {
    const request = route.request();
    if (request.method() === "PUT" && request.postDataJSON().progress_value === 0) {
      resetStarted();
      await released;
    }
    await route.fallback();
  });
  try {
    await page.getByRole("button", { name: "Xóa tiến độ truyện Truyện đọc lại", exact: true }).click();
    await started;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
    });
    releaseReset();
    await expect(page.getByRole("status").filter({ hasText: "Đã đặt lại" })).toBeVisible();
    await expect.poll(async () => (await readDeviceProgress(page)).queued.length).toBe(0);
    expect(writes.filter((value) => value.book_id === "book-1"))
      .toEqual([{ book_id: "book-1", chapter_id: "chapter-1", progress_value: 0 }]);
    expect(writes.filter((value) => value.book_id === "book-2"))
      .toEqual([{ book_id: "book-2", chapter_id: "other-chapter", progress_value: 30 }]);
  } finally {
    releaseReset();
  }
});

for (const failure of ["save", "no-chapters"] as const) {
  test(`reset preserves progress when ${failure} fails`, async ({ page }) => {
    await openMyBooks(page, failure);
    const before = await readDeviceProgress(page);
    await page.getByRole("button", { name: "Xóa tiến độ truyện Truyện đọc lại", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Không thể đặt lại" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Đọc tiếp", exact: true }).first()).toHaveAttribute("href", "/read?id=book-1&chapter=chapter-8");
    expect(await readDeviceProgress(page)).toEqual(before);
  });
}
