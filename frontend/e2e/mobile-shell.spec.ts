import { expect, test, type Page } from "@playwright/test";

async function openMockReader(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("auth_token", "reader-test-token");
    localStorage.setItem(
      "auth_user",
      JSON.stringify({ user_id: "user-1", email: "reader@example.com" }),
    );
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const corsHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
    };
    const chapters = [1, 2, 3].map((number) => ({
      id: `chapter-${number}`,
      book_id: "book-1",
      chapter_index: number - 1,
      title: `Chương ${number}`,
      word_count: 120,
      status: "ready",
      updated_at: "2026-09-03T00:00:00Z",
    }));

    if (request.method() !== "GET") {
      await route.fulfill({ status: 204, headers: corsHeaders });
    } else if (url.pathname === "/api/books/book-1") {
      await route.fulfill({
        headers: corsHeaders,
        json: {
          id: "book-1",
          title: "Truyện thử nghiệm",
          author: "Tác giả",
          voice: "",
          status: "ready",
          total_chapters: chapters.length,
          created_at: "2026-09-03T00:00:00Z",
          genres: [],
        },
      });
    } else if (url.pathname === "/api/books/book-1/chapters") {
      await route.fulfill({
        headers: corsHeaders,
        json: {
          items: chapters,
          total: chapters.length,
          page: 1,
          page_size: 10_000,
          total_pages: 1,
        },
      });
    } else if (url.pathname === "/api/chapters/chapter-2/text") {
      await route.fulfill({
        headers: corsHeaders,
        json: {
          id: "chapter-2",
          updated_at: "2026-09-03T00:00:00Z",
          text_content: Array.from(
            { length: 18 },
            (_, index) =>
              `Đoạn văn ${index + 1}. Nội dung thử nghiệm đủ dài để kiểm tra cách trình đọc hiển thị trên màn hình điện thoại Android.`,
          ).join("\n\n"),
        },
      });
    } else if (url.pathname === "/api/progress/book/book-1") {
      await route.fulfill({ headers: corsHeaders, json: null });
    } else {
      await route.fulfill({
        status: 404,
        headers: corsHeaders,
        json: { detail: "not mocked" },
      });
    }
  });
  await page.goto("/read?id=book-1&chapter=chapter-2", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { name: "Chương 2", exact: true }),
  ).toBeVisible();
}

test("consumer shell fits and keeps navigation targets accessible", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toBeVisible();

  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);

  const navigationTargets = page.locator("nav a:visible, nav button:visible");
  expect(await navigationTargets.count()).toBeGreaterThan(0);
  for (const target of await navigationTargets.all()) {
    const box = await target.boundingBox();
    expect(box, "visible navigation target has a box").not.toBeNull();
    expect(box!.height, "navigation target height").toBeGreaterThanOrEqual(44);
    expect(box!.width, "navigation target width").toBeGreaterThanOrEqual(44);
  }
});

test("reduced motion removes long-running UI transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const durations = await page.evaluate(() => {
    const element = document.querySelector("button, a");
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      animation: style.animationDuration,
      transition: style.transitionDuration,
    };
  });
  expect(durations).not.toBeNull();
  expect(durations!.animation).not.toMatch(/^[1-9]\d*(?:\.\d+)?s$/);
  expect(durations!.transition).not.toMatch(/^[1-9]\d*(?:\.\d+)?s$/);
});

test("reader stays usable at Android viewport sizes", async ({ page }) => {
  await openMockReader(page);

  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);

  for (const name of ["Chương 1", "Danh sách chương", "Chương 3"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box, `${name} has a visible touch target`).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("button", { name: "Cài đặt đọc" }).click();
  const settings = page.getByRole("dialog", { name: "Cài đặt đọc" });
  await expect(settings.getByText("Mỗi trang sách nên êm mắt", { exact: false })).toBeVisible();
  await settings.getByRole("slider", { name: "Độ dài dòng" }).fill("32");
  await expect
    .poll(() =>
      page.locator("#reader-chapter-title").evaluate((element) =>
        (element.parentElement as HTMLElement).style.maxWidth,
      ),
    )
    .toBe("32ch");
  await settings.getByRole("button", { name: "Đóng" }).click();

  await page.getByRole("button", { name: "Danh sách chương" }).click();
  const toc = page.getByRole("dialog", { name: "Mục lục" });
  const search = toc.getByRole("textbox", { name: "Tìm chương theo số hoặc tiêu đề..." });
  await search.fill("3");
  await expect(toc.getByRole("button", { name: "Xóa tìm kiếm" })).toBeVisible();
  await toc.getByRole("button", { name: "Xóa tìm kiếm" }).click();
  await expect(search).toHaveValue("");
});
