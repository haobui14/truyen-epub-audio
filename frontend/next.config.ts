import type { NextConfig } from "next";
import withSerwist from "@serwist/next";
import pkg from "./package.json";

const isCapacitor = process.env.BUILD_TARGET === "capacitor";
const mediaHostname = (() => {
  try {
    return process.env.NEXT_PUBLIC_MEDIA_URL
      ? new URL(process.env.NEXT_PUBLIC_MEDIA_URL).hostname
      : null;
  } catch {
    throw new Error("NEXT_PUBLIC_MEDIA_URL must be a valid absolute URL");
  }
})();

const withPWA = isCapacitor
  ? (config: NextConfig) => config
  : withSerwist({
      swSrc: "app/sw.ts",
      swDest: "public/sw.js",
      disable: process.env.NODE_ENV === "development",
    });

const nextConfig: NextConfig = {
  ...(isCapacitor ? { output: "export" } : {}),
  env: {
    // Baked at build time. The APK compares this against the backend's
    // /api/app-version to show an update notice (see UpdateNotice.tsx).
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  images: {
    ...(isCapacitor ? { unoptimized: true } : {}),
    remotePatterns: [
      // Kept during migration so existing cover_url rows still render until
      // scripts/migrate_supabase_storage_to_r2.py updates them.
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      ...(mediaHostname
        ? [{ protocol: "https" as const, hostname: mediaHostname, pathname: "/**" }]
        : []),
    ],
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default withPWA(nextConfig);
