import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Truyện Audio Việt Nam",
    short_name: "TruyệnAudio",
    description: "Nghe truyện EPUB tiếng Việt",
    start_url: "/",
    display: "standalone",
    background_color: "#0d0c10",
    theme_color: "#1b1b22",
    orientation: "portrait-primary",
    categories: ["entertainment", "books"],
    lang: "vi",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
