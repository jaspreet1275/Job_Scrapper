import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// UI sans (Inter) — variable weights, designed for screen UI. Used
// everywhere via Tailwind's `font-sans` (mapped through `@theme inline`
// in globals.css). Mono (JetBrains_Mono) is reserved for timestamps,
// code blocks, and tabular numerics in the activity log.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ScraperAI · Recruitment Ops",
  description:
    "Scrape job alerts, enrich decision-makers, and ship cold outreach.",
};

// Pre-hydration theme init. Runs as the very first thing in <head> so
// the `data-theme` attribute is set before React mounts, avoiding a
// flash of the wrong palette. Reads localStorage; falls back to
// "light" (per design discussion, light is the default first-visit
// experience).
const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var theme = stored === 'dark' || stored === 'light' ? stored : 'light';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="light"
      // The themeInitScript below rewrites data-theme from localStorage before
      // React hydrates, so the server "light" vs client "dark" attribute will
      // legitimately differ. Suppress the (expected) hydration warning for it.
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
