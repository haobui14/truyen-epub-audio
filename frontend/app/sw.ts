import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist, CacheFirst, NetworkFirst, ExpirationPlugin } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Audio files — explicit cache-first (user taps download)
    {
      matcher: /^https:\/\/.*\.supabase\.co\/storage\/v1\/object\/public\/audio\/.*/i,
      handler: new CacheFirst({
        cacheName: "audio-cache-v1",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 50,
            maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
          }),
        ],
      }),
    },
    // Cover images — cache-first
    {
      matcher: /^https:\/\/.*\.supabase\.co\/storage\/v1\/object\/public\/covers\/.*/i,
      handler: new CacheFirst({
        cacheName: "covers-cache-v1",
        plugins: [
          new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 }),
        ],
      }),
    },
    // API responses — network-first with fallback
    {
      matcher: /\/api\/(books|chapters|audio|tts).*/i,
      handler: new NetworkFirst({
        cacheName: "api-cache-v1",
        networkTimeoutSeconds: 10,
        plugins: [
          new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 5 * 60 }),
        ],
      }),
    },
    // Default Next.js caching strategies
    ...defaultCache,
  ],
});

serwist.addEventListeners();
