import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import AppShell from "@/components/AppShell";
import InitDB from "@/components/InitDB";
import { THEME_INIT_SCRIPT } from "@/lib/theme-script";

// Fonts are self-hosted (src/app/fonts, from Fontsource) so builds never fetch
// from Google Fonts — a failed fetch on Vercel broke the Turbopack build.
const syne = localFont({
  src: "./fonts/syne-latin-wght-normal.woff2",
  weight: "400 800",
  variable: "--font-syne",
});

const instrument = localFont({
  src: "./fonts/instrument-sans-latin-wght-normal.woff2",
  weight: "400 700",
  variable: "--font-instrument",
});

const plexMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-mono",
});

// Wordmark/brand type — modern geometric sans that pairs with the V mark.
const spaceGrotesk = localFont({
  src: "./fonts/space-grotesk-latin-wght-normal.woff2",
  weight: "300 700",
  variable: "--font-brand",
});

export const metadata: Metadata = {
  // Absolute base for social-share / Open Graph URLs.
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://vybecut.com"),
  title: "Vybe — Content Scheduler",
  description: "Schedule and manage social media posts across Instagram, X, TikTok, and YouTube",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the theme script adds "light" to <html> before React hydrates.
    <html lang="en" suppressHydrationWarning className={`${syne.variable} ${instrument.variable} ${plexMono.variable} ${spaceGrotesk.variable}`}>
      <head>
        {/* Apply the saved light/dark theme before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="bg-d0a antialiased">
        <InitDB />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
