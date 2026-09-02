import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "@fontsource/cormorant-garamond/400.css";
import "@fontsource/cormorant-garamond/500.css";
import "@fontsource/cormorant-garamond/600.css";
import "@fontsource/cormorant-garamond/400-italic.css";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import { Providers } from "./providers";
import { BottomNav } from "@/components/ui/BottomNav";
import { MiniPlayer } from "@/components/player/MiniPlayer";
import { PlayerPadding } from "@/components/player/PlayerPadding";
import { AppHeader, AppMain, AppFooter } from "@/components/ui/AppChrome";

export const metadata: Metadata = {
  title: "Truyện Audio Việt Nam",
  description: "Nghe và đọc truyện tiếng Việt",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "TruyệnAudio",
  },
};

export const viewport: Viewport = {
  themeColor: "#1a1a1f",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi" className="dark">
      <body className="font-sans antialiased bg-ink text-text min-h-screen flex flex-col">
        <Providers>
          <div
            className="fixed top-0 inset-x-0 bg-ink z-50"
            style={{ height: "var(--sat)" }}
          />
          <AppHeader />
          <AppMain>
            {children}
            <PlayerPadding />
          </AppMain>
          <AppFooter />
          <MiniPlayer />
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}
