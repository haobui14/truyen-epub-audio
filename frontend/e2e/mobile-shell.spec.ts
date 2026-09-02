import { expect, test } from "@playwright/test";

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
