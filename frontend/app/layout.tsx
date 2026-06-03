import type { Metadata, Viewport } from "next";
import { Inter, Cormorant_Garamond, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { BottomNav } from "@/components/ui/BottomNav";
import { MiniPlayer } from "@/components/player/MiniPlayer";
import { PlayerPadding } from "@/components/player/PlayerPadding";
import { AppHeader, AppMain, AppFooter } from "@/components/ui/AppChrome";

const inter = Inter({
  subsets: ["latin", "vietnamese"],
  variable: "--font-sans",
  display: "swap",
});

const cormorant = Cormorant_Garamond({
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

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
    <html
      lang="vi"
      className={`dark ${inter.variable} ${cormorant.variable} ${jetbrains.variable}`}
    >
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
