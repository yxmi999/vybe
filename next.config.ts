import type { NextConfig } from "next";

// Desktop build (desktop/build.mjs sets VYBE_DESKTOP_BUILD=1): a self-contained
// "standalone" server the Electron app runs locally. Its node_modules are
// traced, so the ffmpeg / yt-dlp binaries (spawned, never require()d) must be
// pulled in explicitly. The web/cloud build is unaffected.
const desktopBuild = process.env.VYBE_DESKTOP_BUILD === "1";

const nextConfig: NextConfig = {
  ...(desktopBuild ? { output: "standalone" as const } : {}),
  // Allow other devices on the LAN (e.g. your phone) to load Next.js dev
  // resources. Without this, Next 16 blocks /_next/* + HMR from non-localhost
  // origins, so the page renders but never hydrates and nothing is clickable.
  allowedDevOrigins: ["192.168.100.77", "192.168.100.*", "192.168.*.*"],
  // Rendering reads the bundled video fonts from disk (process.cwd()/
  // public). On serverless hosts public/ is served from the CDN and is NOT in
  // the function bundle unless traced in explicitly — without this, exports
  // would silently fall back to no font / no watermark in production.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./public/fonts/**/*",
      "./public/sfx/**/*", // built-in sound effects mixed in by the renderer
      ...(desktopBuild ? [
        "./node_modules/@ffmpeg-installer/win32-x64/**/*",
        "./node_modules/yt-dlp-exec/bin/**/*",
      ] : []),
    ],
  },
  // Code that reads files relative to process.cwd() makes the tracer pull in
  // the whole project; keep every server bundle (web and desktop) to what the
  // server needs — and never the developer's own clips, DB or env files.
  // Each Vercel deployment's functions count against Function Storage.
  outputFileTracingExcludes: {
    "*": [
      "./public/uploads/**", "./desktop/**", "./docs/**", "./scripts/**", "./src/**",
      "./*.md", "./vybe.db*", "./.env*", "./**/.env", "./.git/**", "./.claude/**",
      "./tsconfig.tsbuildinfo", "./package-lock.json",
    ],
  },
  serverExternalPackages: [
    "yt-dlp-exec",
    "@ffmpeg-installer/ffmpeg",
    "fluent-ffmpeg",
    "@ffmpeg-installer/win32-x64",
    "@ffmpeg-installer/linux-x64",
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "500mb",
    },
    proxyClientMaxBodySize: "500mb",
  },
};

export default nextConfig;
