// electron-builder afterPack hook: copy the local server (app-server/) into
// resources/ ourselves. electron-builder's extraResources always drops
// node_modules folders, but the standalone Next server needs its traced
// node_modules (next, react, ffmpeg/yt-dlp binaries…) next to server.js.
// Runs after the app is laid out and before the installer is built, so the
// NSIS setup contains it too.
"use strict";
const fs = require("fs");
const path = require("path");

exports.default = async function afterPack(context) {
  const src = path.join(__dirname, "app-server");
  const dest = path.join(context.appOutDir, "resources", "app-server");
  if (!fs.existsSync(path.join(src, "server.js"))) {
    throw new Error("desktop/app-server is missing — run `npm run build:server` first.");
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  for (const rel of ["server.js", "node_modules/next/package.json", ".next/BUILD_ID"]) {
    if (!fs.existsSync(path.join(dest, rel))) throw new Error(`afterPack: ${rel} missing from the packaged server`);
  }
  // Second line of defence (build.mjs sweeps first): never package env files
  // or databases — they could hold the developer's keys or data.
  const leaks = [];
  const scan = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) scan(p);
      else if (/^\.env/.test(name) || /\.db$/.test(name)) leaks.push(path.relative(dest, p));
    }
  };
  scan(dest);
  if (leaks.length) throw new Error(`afterPack: refusing to package private files: ${leaks.join(", ")}`);
  console.log(`  • copied app-server → ${path.relative(process.cwd(), dest)}`);
};
