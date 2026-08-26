import type { NextConfig } from "next";
import withSerwist from "@serwist/next";
import pkg from "./package.json";

const isCapacitor = process.env.BUILD_TARGET === "capacitor";

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
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
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
