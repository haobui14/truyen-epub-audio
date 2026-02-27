import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import Link from "next/link";
import { DarkModeToggle } from "@/components/ui/DarkModeToggle";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  title: "Truyện Audio Việt Nam",
  description: "Nghe và đọc truyện EPUB tiếng Việt với giọng đọc AI",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "TruyệnAudio",
  },
};

export const viewport: Viewport = {
  themeColor: "#6366f1",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        {/* Prevent flash of wrong theme on load */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t===null&&d))document.documentElement.classList.add('dark')})()`,
          }}
        />
      </head>
      <body className={`${geist.variable} font-sans antialiased bg-gray-50 dark:bg-gray-950 min-h-screen flex flex-col`}>
        <Providers>
          <header className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-md border-b border-gray-200/60 dark:border-gray-800/60 sticky top-0 z-40">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
              <Link href="/" className="flex items-center gap-2 group">
                <div className="w-8 h-8 bg-linear-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center shadow-sm group-hover:shadow-md transition-shadow">
                  <svg className="w-4.5 h-4.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                </div>
                <span className="font-bold text-gray-900 dark:text-gray-100 text-lg tracking-tight">
                  Truyện<span className="text-indigo-600 dark:text-indigo-400">Audio</span>
                </span>
              </Link>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <DarkModeToggle />
                <Link
                  href="/upload"
                  className="flex items-center gap-1.5 bg-indigo-600 text-white text-sm font-medium px-3.5 sm:px-4 py-2 rounded-lg hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-sm hover:shadow-md"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  <span className="hidden sm:inline">Tải lên</span>
                </Link>
              </div>
            </div>
          </header>
          <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">{children}</main>
          <footer className="border-t border-gray-200/60 dark:border-gray-800/60 bg-white/50 dark:bg-gray-900/50 mt-auto">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-400 dark:text-gray-500">
              <p>&copy; {new Date().getFullYear()} TruyệnAudio. Nghe và đọc truyện EPUB tiếng Việt.</p>
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  AI-Powered TTS
                </span>
                <span className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  PWA Ready
                </span>
              </div>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
