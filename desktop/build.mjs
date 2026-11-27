// Build the local server the desktop app runs: `next build` in desktop mode
// (standalone output), then assemble desktop/app-server/ with everything the
// standalone server needs at runtime. electron-builder ships that folder.
//
//   node desktop/build.mjs        (or, from desktop/: npm run build:server)
import { spawnSync } from "child_process";
import { cpSync, existsSync, rmSync, readdirSync, statSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(here, "app-server");
const PORT = process.env.VYBE_DESKTOP_PORT || "47321";

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
  return r.status ?? 1;
}

// next/font downloads Google Fonts during the build and that fetch fails
// intermittently ("Can't resolve …/font/google/font") — retry before giving up.
let status = 1;
for (let attempt = 1; attempt <= 3 && status !== 0; attempt++) {
  console.log(`▸ next build (desktop / standalone)${attempt > 1 ? ` — retry ${attempt}/3` : ""}…`);
  status = run("npx", ["next", "build"], {
    VYBE_DESKTOP_BUILD: "1",
    // NEXT_PUBLIC_* is inlined at build time — the desktop app's local address.
    NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
    NEXT_TELEMETRY_DISABLED: "1",
  });
}
if (status !== 0) process.exit(status);

const standalone = path.join(root, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("✗ .next/standalone/server.js missing — is output: 'standalone' enabled for VYBE_DESKTOP_BUILD?");
  process.exit(1);
}

console.log("▸ assembling desktop/app-server…");
rmSync(out, { recursive: true, force: true });
cpSync(standalone, out, { recursive: true });
cpSync(path.join(root, ".next", "static"), path.join(out, ".next", "static"), { recursive: true });
// Bundled public assets (fonts, icons) — never the dev machine's uploads.
cpSync(path.join(root, "public"), path.join(out, "public"), {
  recursive: true,
  filter: (src) => !src.split(path.sep).includes("uploads"),
});

// The tracer copies server-external packages (next.config serverExternal
// Packages) but not always their dependencies — yt-dlp-exec arrived without
// dargs/execa/…, so every yt-dlp download would crash. Copy each external's
// full dependency closure from the project's node_modules (npm's flat
// layout; a package's own nested node_modules come along with it).
const { readFileSync } = await import("fs");
const EXTERNALS = ["yt-dlp-exec", "fluent-ffmpeg", "@ffmpeg-installer/ffmpeg"];
const seen = new Set();
let depCopies = 0;
const closure = (name) => {
  if (seen.has(name)) return;
  seen.add(name);
  const src = path.join(root, "node_modules", name);
  if (!existsSync(path.join(src, "package.json"))) return; // optional / platform dep not installed
  // Always mirror the whole package: the tracer sometimes copies only the
  // files IT saw used (e.g. half of `which`), which breaks other importers.
  const dst = path.join(out, "node_modules", name);
  cpSync(src, dst, { recursive: true, force: true });
  depCopies++;
  const pkg = JSON.parse(readFileSync(path.join(src, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) closure(dep);
};
for (const e of EXTERNALS) closure(e);
console.log(`  external deps: ${seen.size} packages checked, ${depCopies} copied`);

// Next loads server-external packages from renamed copies under
// .next/node_modules (e.g. @ffmpeg-installer/ffmpeg-<hash>). ffmpeg-installer
// looks for its platform binary package NEXT TO ITSELF, which the tracer only
// placed in the top-level node_modules — put a copy where it looks.
const ffSrc = path.join(out, "node_modules", "@ffmpeg-installer", "win32-x64");
const ffDst = path.join(out, ".next", "node_modules", "@ffmpeg-installer", "win32-x64");
if (existsSync(ffSrc) && existsSync(path.dirname(ffDst))) cpSync(ffSrc, ffDst, { recursive: true });

// Sweep LAST — after every copy step above (the dependency closure can
// bring files back, e.g. an npm package that publishes its own .env).
// Never ship the developer's secrets or data — whatever the tracer picked up:
// .env files and SQLite DBs at ANY depth (some npm packages even publish an
// .env), the developer's own clips, and project files the server never reads.
// The desktop app gets its keys from the Settings page.
let removed = 0;
const sweep = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { sweep(p); continue; }
    if (/^\.env/.test(name) || /\.db(-journal|-wal|-shm)?$/.test(name)) { rmSync(p, { force: true }); removed++; }
  }
};
sweep(out);
for (const rel of ["public/uploads", "desktop", "docs", "scripts", "src", "AGENTS.md", "CLAUDE.md", "README.md", ".claude", ".git"]) {
  const p = path.join(out, rel);
  if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); removed++; }
}
console.log(`  removed ${removed} developer-only file(s)/folder(s)`);
mkdirSync(path.join(out, "public", "uploads"), { recursive: true });

// Sanity: the binaries the app spawns must be there.
const must = [
  "node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe",
  ".next/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe",
  "node_modules/yt-dlp-exec/bin/yt-dlp.exe",
];
let ok = true;
for (const rel of must) {
  if (!existsSync(path.join(out, rel))) { console.error(`✗ missing ${rel}`); ok = false; }
}
// …and nothing private must remain.
const leaks = [];
const scan = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) scan(p);
    else if (/^\.env/.test(name) || /\.db$/.test(name)) leaks.push(path.relative(out, p));
  }
};
scan(out);
if (readdirSync(path.join(out, "public", "uploads")).length > 0) leaks.push("public/uploads/*");
if (leaks.length) { console.error(`✗ private files in bundle: ${leaks.join(", ")}`); ok = false; }
const size = (dir) => readdirSync(dir).reduce((n, f) => {
  const p = path.join(dir, f); const s = statSync(p);
  return n + (s.isDirectory() ? size(p) : s.size);
}, 0);
console.log(`${ok ? "✓" : "✗"} app-server ready (${(size(out) / 1e6).toFixed(0)} MB)`);
process.exit(ok ? 0 : 1);
