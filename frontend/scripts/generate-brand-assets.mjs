// All web and Android brand assets derive from the approved vector master.
// Run from frontend/: node scripts/generate-brand-assets.mjs
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// Sharp is provided by Next.js's existing image dependency.
const sharp = createRequire(require.resolve("next/package.json"))("sharp");
const mark = await readFile(join(root, "public/brand/story-flame.svg"));
const ink = "#0d1117";
const icons = join(root, "public/icons");
const resources = join(root, "android/app/src/main/res");

async function renderMark(width, height, fraction) {
  const markHeight = Math.round(Math.min(width, height) * fraction);
  const markWidth = Math.round(markHeight * 320 / 360);
  const input = await sharp(mark, { density: 384 })
    .resize(markWidth, markHeight).png().toBuffer();
  return {
    input,
    left: Math.round((width - markWidth) / 2),
    top: Math.round((height - markHeight) / 2),
  };
}

async function writeIcon(path, width, height, { fraction = 0.84, transparent = false, round = false } = {}) {
  const symbol = await renderMark(width, height, fraction);
  let image = sharp({
    create: {
      width, height, channels: 4,
      background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : ink,
    },
  }).composite([symbol]);
  if (round) {
    const mask = Buffer.from(`<svg width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${width / 2}" fill="white"/></svg>`);
    image = sharp(await image.png().toBuffer()).composite([{ input: mask, blend: "dest-in" }]);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await image.png({ compressionLevel: 9 }).toBuffer());
}

for (const [file, size, fraction] of [
  ["icon-192.png", 192, 0.84],
  ["icon-512.png", 512, 0.84],
  ["maskable-192.png", 192, 0.66],
  ["maskable-512.png", 512, 0.66],
  ["apple-touch-icon-180.png", 180, 0.84],
  ["favicon-32.png", 32, 0.9],
  ["favicon-16.png", 16, 0.94],
]) {
  await writeIcon(join(icons, file), size, size, { fraction });
}

for (const [density, size] of [
  ["mdpi", 48], ["hdpi", 72], ["xhdpi", 96],
  ["xxhdpi", 144], ["xxxhdpi", 192],
]) {
  const folder = join(resources, `mipmap-${density}`);
  await writeIcon(join(folder, "ic_launcher.png"), size, size);
  await writeIcon(join(folder, "ic_launcher_round.png"), size, size, { round: true });
}

// The adaptive icon's 108dp layer is 432px at xxxhdpi. A 54%-height symbol
// keeps every painted pixel inside its central 66dp safe circle.
await writeIcon(join(resources, "mipmap-xxxhdpi/ic_launcher_foreground.png"), 432, 432, {
  fraction: 0.54, transparent: true,
});
await writeFile(
  join(resources, "mipmap-xxxhdpi/ic_launcher_background.png"),
  await sharp({ create: { width: 432, height: 432, channels: 4, background: ink } }).png().toBuffer(),
);

// Replace the default Capacitor splash in every existing orientation/density,
// preserving its canvas size so resource selection and sizing stay consistent.
let splashCount = 0;
for (const entry of await readdir(resources, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("drawable")) continue;
  const folder = join(resources, entry.name);
  if (!(await readdir(folder)).includes("splash.png")) continue;
  const path = join(folder, "splash.png");
  const { width, height } = await sharp(path).metadata();
  await writeIcon(path, width, height, { fraction: 0.28 });
  splashCount++;
}

console.log(`Generated 7 web icons, 12 Android launcher layers/icons, and ${splashCount} splash screens.`);
