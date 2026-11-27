// postinstall: on Linux (Vercel / any cloud host), replace yt-dlp-exec's
// default binary with yt-dlp's standalone build.
//
// yt-dlp-exec downloads the release asset named "yt-dlp", which is a Python
// zipapp (`#!/usr/bin/env python3`). Serverless Node runtimes ship no python3,
// so every download failed with "env: 'python3': No such file or directory".
// "yt-dlp_linux" is a self-contained PyInstaller build that needs no Python.
// Windows/macOS keep the binaries yt-dlp-exec already installs.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "linux") process.exit(0);

const asset = process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
const dest = path.join(process.cwd(), "node_modules", "yt-dlp-exec", "bin", "yt-dlp");

try {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`suspiciously small download (${buf.length} bytes)`);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf, { mode: 0o755 });
  console.log(`[fetch-yt-dlp] installed ${asset} (${(buf.length / 1e6).toFixed(1)} MB) → ${dest}`);
} catch (err) {
  // Don't fail the whole install on a GitHub hiccup — but make it loud.
  console.warn(`[fetch-yt-dlp] WARNING: could not fetch ${asset}: ${err?.message ?? err}. ` +
    "Clip downloads will fail on hosts without python3.");
}
