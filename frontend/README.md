# TruyệnAudio — Frontend

Next.js 16 (App Router) + Tailwind CSS v4 + Capacitor (Android). Static export
on Capacitor builds, server-rendered on Vercel for the web. PWA via `next-pwa`
(serwist).

See `../CODEBASE.md` for the architecture deep-dive and `../docs/android-player.md`
for the native Android TTS state machine.

## Dev

```bash
npm install
npm run dev          # localhost:3000 — must use --webpack flag (next-pwa is
                     # not compatible with Turbopack)
```

Required env (`.env.local` — copy from `.env.local.example`):

```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Backend lives in `../backend`.

## Build

```bash
npm run build              # Vercel build
BUILD_TARGET=capacitor npm run build && npx cap sync android
```

`BUILD_TARGET=capacitor` flips `next.config.ts` to `output: "export"` and emits
into `out/` for the Capacitor APK. Static export only generates routes listed in
`generateStaticParams`, which is why dynamic paths (`/books/[bookId]`) have
search-param wrappers (`/book?id=`, `/listen?id=&chapter=`, `/read?id=&chapter=`).

## Android

```bash
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
adb logcat -s TtsPlayback     # live logs from the foreground TTS service
```

## Visual system

Dark-only "lacquered ink" theme. Tokens in `app/globals.css` under `@theme`:
`--color-ink/surface/raised/raised-hi`, `--color-text/text-dim/text-mute/text-faint`,
`--color-accent` (jade), `--color-vermillion` (seal moments), `--color-gold`
(XP / sleep timer). Fonts: Cormorant Garamond display, Inter sans, JetBrains
Mono mono — all loaded via `next/font/google`.

`<html class="dark">` is forced on the root. Light mode is intentionally not
supported.
