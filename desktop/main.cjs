// Vybe desktop — Electron shell around the same Next.js app as the cloud
// version, running it as a local server on this machine (VYBE_DESKTOP=1).
//
//   • Starts the bundled standalone server (app-server/) with Electron's own
//     Node, bound to 127.0.0.1 on a fixed port (OAuth redirect URIs need a
//     stable address) and a per-user writable data folder (DB + clips).
//   • Signs the window in as the single local user — no login screen.
//   • Keeps the user's API keys encrypted with the OS keychain (safeStorage)
//     and pushes them to the server at start and on every Settings save.
//   • Runs the post scheduler (every minute) and Auto-Pilot (every 10 min) —
//     the jobs Vercel Cron runs for the cloud version — while the app is open,
//     including from the system tray after the window is closed.
"use strict";
const { app, BaseWindow, Tray, Menu, ipcMain, shell, safeStorage, session, dialog, nativeImage, powerSaveBlocker } = require("electron");
const { Tabs } = require("./tabs.cjs");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const net = require("net");

const PORT = Number(process.env.VYBE_DESKTOP_PORT) || 47321;
const APP_URL = `http://localhost:${PORT}`;      // what the window + OAuth redirects use
const API_URL = `http://127.0.0.1:${PORT}`;      // what this process calls (no IPv6 surprises)
const KEY_NAMES = [
  "GOOGLE_GENERATIVE_AI_API_KEYS", "GROQ_API_KEYS", "FAL_KEY",
  "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET",
  "TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET",
  "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET",
  "INSTAGRAM_CLIENT_ID", "INSTAGRAM_CLIENT_SECRET",
];
const SINGLE_OF = { GOOGLE_GENERATIVE_AI_API_KEYS: "GOOGLE_GENERATIVE_AI_API_KEY", GROQ_API_KEYS: "GROQ_API_KEY" };

// ── Paths ────────────────────────────────────────────────────────────────────
// VYBE_USER_DATA: throwaway profile for tests/smoke runs (never the real one).
if (process.env.VYBE_USER_DATA) app.setPath("userData", process.env.VYBE_USER_DATA);
const userDir = app.getPath("userData");
const dataDir = path.join(userDir, "data");          // DB + uploads (VYBE_DATA_DIR)
const logDir = path.join(userDir, "logs");
const keysFile = path.join(userDir, "keys.bin");
const installFile = path.join(userDir, "install.json");
// Packaged: resources/app-server. Dev (`npm start` in desktop/): ./app-server.
const serverDir = app.isPackaged ? path.join(process.resourcesPath, "app-server") : path.join(__dirname, "app-server");
const iconPath = path.join(__dirname, "assets", "icon.png");

let win = null;          // BaseWindow: toolbar + one view per tab (tabs.cjs)
let tabs = null;
let loadingTab = null;   // the first tab, showing loading.html while booting
let chromeDuringLoading = null; // smoke test: was the tab bar visible on the loading screen?
let tray = null;
let server = null;
let quitting = false;
let serverRestarts = 0;
const controlToken = crypto.randomBytes(24).toString("hex");  // per launch
const cronSecret = crypto.randomBytes(24).toString("hex");    // per launch

// ── Single instance ──────────────────────────────────────────────────────────
// Smoke runs capture the window offscreen-style; GPU compositing can't be
// relied on there (headless sessions, RDP), so render in software.
if (process.env.VYBE_SMOKE_SHOT) app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
}

// ── Install secrets + encrypted key store ───────────────────────────────────
function installSecrets() {
  try { return JSON.parse(fs.readFileSync(installFile, "utf8")); } catch { /* first run */ }
  const s = { jwtSecret: crypto.randomBytes(48).toString("hex"), createdAt: new Date().toISOString() };
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(installFile, JSON.stringify(s, null, 2));
  return s;
}

function readKeys() {
  try {
    const raw = fs.readFileSync(keysFile);
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
    const obj = JSON.parse(json);
    return Object.fromEntries(KEY_NAMES.filter((k) => typeof obj[k] === "string" && obj[k]).map((k) => [k, obj[k]]));
  } catch {
    return {};
  }
}

function writeKeys(keys) {
  const json = JSON.stringify(keys);
  fs.mkdirSync(userDir, { recursive: true });
  // Encrypted with the OS keychain (DPAPI on Windows) — unreadable by other users.
  fs.writeFileSync(keysFile, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, "utf8"));
}

const hint = (v) => (v.length > 8 ? `…${v.slice(-4)}` : "set");
function maskedKeys(keys) {
  return Object.fromEntries(KEY_NAMES.map((k) => [k, keys[k] ? { set: true, hint: hint(keys[k]) } : { set: false, hint: "" }]));
}

function keyEnv(keys) {
  const env = {};
  for (const k of KEY_NAMES) if (keys[k]) env[k] = keys[k];
  for (const [multi, single] of Object.entries(SINGLE_OF)) {
    const first = (keys[multi] || "").split(",").map((s) => s.trim()).find(Boolean);
    if (first) env[single] = first;
  }
  return env;
}

// ── Local server ─────────────────────────────────────────────────────────────
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

function logStream() {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, "server.log");
  try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, path.join(logDir, "server.old.log")); } catch { /* no log yet */ }
  return fs.createWriteStream(file, { flags: "a" });
}

function startServer() {
  const secrets = installSecrets();
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    // Never the hosted database from the desktop app (see src/lib/db.ts).
    TURSO_DATABASE_URL: "",
    TURSO_AUTH_TOKEN: "",
    NODE_ENV: "production",
    PORT: String(PORT),
    HOSTNAME: "127.0.0.1",
    VYBE_DESKTOP: "1",
    VYBE_DATA_DIR: dataDir,
    VYBE_DESKTOP_TOKEN: controlToken,
    JWT_SECRET: secrets.jwtSecret,
    CRON_SECRET: cronSecret,
    NEXT_PUBLIC_APP_URL: APP_URL,
    YOUTUBE_REDIRECT_URI: `${APP_URL}/api/auth/youtube`,
    TWITTER_REDIRECT_URI: `${APP_URL}/api/auth/twitter`,
    TIKTOK_REDIRECT_URI: `${APP_URL}/api/auth/tiktok`,
    INSTAGRAM_REDIRECT_URI: `${APP_URL}/api/auth/instagram`,
    NEXT_TELEMETRY_DISABLED: "1",
    ...keyEnv(readKeys()),
  };
  const out = logStream();
  out.write(`\n=== ${new Date().toISOString()} starting server (v${app.getVersion()}) ===\n`);
  server = spawn(process.execPath, [path.join(serverDir, "server.js")], { cwd: serverDir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.pipe(out, { end: false });
  server.stderr.pipe(out, { end: false });
  server.on("exit", (code) => {
    out.write(`=== server exited (${code}) ===\n`);
    server = null;
    if (quitting) return;
    // Crash: restart with backoff, but don't loop forever on a broken install.
    if (serverRestarts++ < 5) setTimeout(() => boot(false).catch(fatal), 2000 * serverRestarts);
    else fatal(new Error("The local server keeps stopping. See the log in " + logDir));
  });
}

async function waitForServer(timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${API_URL}/api/init`);   // also runs DB migrations
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (!server) throw new Error("The local server stopped while starting. See the log in " + logDir);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("The local server didn't start in time. See the log in " + logDir);
}

async function control(pathname, body) {
  const r = await fetch(`${API_URL}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vybe-desktop": controlToken },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`${pathname} failed (${r.status})`);
  return r.json();
}

// Sign the window in as the local user (the session cookie the web app uses).
async function signIn() {
  const { token } = await control("/api/desktop/session");
  await session.defaultSession.cookies.set({
    url: APP_URL, name: "vybe_token", value: token, httpOnly: true, sameSite: "lax",
    expirationDate: Math.floor(Date.now() / 1000) + 6 * 24 * 3600,
  });
}

// ── Background jobs (what Vercel Cron does for the cloud version) ──────────
let pilotBusy = false;
async function cron(pathname) {
  try {
    await fetch(`${API_URL}${pathname}`, { headers: { authorization: `Bearer ${cronSecret}` } });
  } catch { /* server restarting — next tick */ }
}
async function runPilots() {
  if (pilotBusy || !server) return;
  pilotBusy = true;
  // Keep the machine from sleeping mid-render.
  const blocker = powerSaveBlocker.start("prevent-app-suspension");
  try { await cron("/api/auto-pilot/run"); } finally { powerSaveBlocker.stop(blocker); pilotBusy = false; }
}
function startJobs() {
  setInterval(() => { if (server) cron("/api/scheduler"); }, 60_000);
  setInterval(runPilots, 10 * 60_000);
  setInterval(() => signIn().catch(() => {}), 24 * 3600_000);   // keep the session fresh
  setTimeout(() => { cron("/api/scheduler"); runPilots(); }, 15_000);
}

// ── Window + tray ────────────────────────────────────────────────────────────
// Animated loading screen (loading.html): shown while the server boots. The
// shell narrates the real boot steps on it and fades it out into the app.
const LOADING_FILE = path.join(__dirname, "loading.html");
const loadingReady = { promise: null };

function loadingCall(js) {
  const wc = loadingTab?.view.webContents;
  if (!wc || wc.isDestroyed() || !wc.getURL().startsWith("file:")) return Promise.resolve();
  return wc.executeJavaScript(`window.vybeLoading && ${js}`).catch(() => {});
}
async function loadingStatus(text) {
  await loadingReady.promise;
  return loadingCall(`window.vybeLoading.status(${JSON.stringify(text)})`);
}

function createWindow() {
  win = new BaseWindow({
    width: 1360, height: 860, minWidth: 980, minHeight: 640,
    backgroundColor: "#0a0a0a", title: "Vybe", icon: iconPath, show: !process.argv.includes("--hidden"),
    autoHideMenuBar: true,
  });
  tabs = new Tabs({
    win, appUrl: APP_URL,
    preload: path.join(__dirname, "preload.cjs"),
    toolbarFile: path.join(__dirname, "toolbar.html"),
    toolbarPreload: path.join(__dirname, "toolbar-preload.cjs"),
    stateFile: path.join(userDir, "tabs.json"),
  });
  // The first tab shows the loading screen until the app is up.
  loadingTab = tabs.create(LOADING_FILE, { file: true });
  loadingReady.promise = loadingTab.ready;
  // Closing the window keeps Vybe running in the tray (scheduled posts and
  // Auto-Pilot need it); Quit from the tray menu exits for real.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (tray && !app.__trayHinted) {
      app.__trayHinted = true;
      tray.displayBalloon?.({ title: "Vybe is still running", content: "Scheduled posts and Auto-Pilot keep working. Quit from the tray icon." });
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip("Vybe");
  const menu = () => Menu.buildFromTemplate([
    { label: "Open Vybe", click: showWindow },
    { label: "Run Auto-Pilot now", click: () => runPilots() },
    { type: "separator" },
    {
      label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] }); tray.setContextMenu(menu()); },
    },
    { label: "Open data folder", click: () => shell.openPath(dataDir) },
    { label: "Open logs", click: () => shell.openPath(logDir) },
    { type: "separator" },
    { label: "Quit Vybe", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on("click", showWindow);
}

// ── IPC: the Settings page (via preload) ────────────────────────────────────
// The window also visits OAuth pages (Google, TikTok…) while connecting
// accounts; only the app's own pages may use the bridge.
function fromApp(e) {
  const url = e.senderFrame?.url ?? "";
  return url === APP_URL || url.startsWith(APP_URL + "/");
}
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  if (!fromApp(e)) throw new Error("Not allowed");
  return fn(e, ...args);
});

handle("vybe:getKeys", () => maskedKeys(readKeys()));
handle("vybe:saveKeys", async (_e, values) => {
  const keys = readKeys();
  const changed = {};
  for (const k of KEY_NAMES) {
    if (!values || typeof values[k] !== "string") continue;
    const v = values[k].trim().slice(0, 4000);
    if (v) keys[k] = v; else delete keys[k];
    changed[k] = v;
  }
  writeKeys(keys);
  await control("/api/desktop/env", changed);   // live — no restart needed
  return maskedKeys(keys);
});
handle("vybe:getInfo", () => ({ version: app.getVersion(), dataDir, appUrl: APP_URL }));
handle("vybe:openDataDir", () => shell.openPath(dataDir));
handle("vybe:openExternal", (_e, url) => {
  if (typeof url === "string" && /^https:\/\//.test(url)) return shell.openExternal(url);
});

ipcMain.on("tabs:command", (e, cmd) => {
  if (tabs && e.sender === tabs.toolbar.webContents) tabs.command(cmd);
});

// ── Lifecycle ────────────────────────────────────────────────────────────────
function fatal(err) {
  dialog.showErrorBox("Vybe couldn't start", String(err && err.message ? err.message : err));
  quitting = true;
  app.quit();
}

async function boot(first) {
  if (first && !(await portFree(PORT))) {
    throw new Error(`Port ${PORT} is in use by another program, so Vybe's local server can't start. Close that program (or another copy of Vybe) and try again.`);
  }
  loadingStatus("Starting the local server…");
  startServer();
  // First launch also creates the database — say so if it takes a moment.
  const slow = setTimeout(() => loadingStatus("Setting up your workspace…"), 4000);
  try { await waitForServer(); } finally { clearTimeout(slow); }
  loadingStatus("Signing you in…");
  await signIn();
  serverRestarts = 0;
  if (win && !win.isDestroyed() && tabs) {
    // After a crash-restart: reload the tabs the user already has open.
    if (!first) { tabs.reloadAll(); return; }
    // Fade out into the app — only when someone can see it: a hidden
    // window (started from the tray at login) has its timers throttled,
    // which would stall the fade and delay loading the app.
    if (win.isVisible() && !win.isMinimized()) {
      await loadingStatus("Ready");
      await new Promise((r) => setTimeout(r, 350));
      await loadingCall("window.vybeLoading.finish()");
    }
    // Reopen last session's tabs (the loading tab becomes the first one).
    const saved = process.env.VYBE_SMOKE_SHOT ? null : tabs.saved();
    const urls = saved?.urls ?? [`${APP_URL}/dashboard`];
    await loadingTab.view.webContents.loadURL(urls[0]).catch(() => {});
    const opened = [loadingTab];
    for (const u of urls.slice(1)) opened.push(tabs.create(u, { activate: false, afterId: opened[opened.length - 1].id }));
    tabs.activate((opened[saved?.active ?? 0] ?? loadingTab).id);
    // Only now — the loading screen is gone — show the tab bar.
    chromeDuringLoading = tabs.chrome;
    tabs.showChrome();
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // Google refuses OAuth sign-in from user agents that identify as embedded
  // (Electron); present as the Chrome build Electron is based on.
  app.userAgentFallback = app.userAgentFallback.replace(/\s?Electron\/\S+/, "").replace(/\s?vybe-desktop\/\S+/i, "");
  createWindow();
  createTray();
  try {
    await boot(true);
    if (process.env.VYBE_SMOKE_SHOT) return smokeShot(process.env.VYBE_SMOKE_SHOT);
    startJobs();
  } catch (err) {
    if (process.env.VYBE_SMOKE_SHOT) { console.error("SMOKE FAIL:", err && err.message); quitting = true; app.exit(1); return; }
    fatal(err);
  }
});

// Smoke test for builds (`VYBE_SMOKE_SHOT=out.png npm start`): boot fully,
// exercise the main pages, the Settings bridge and the tab system, capture
// screenshots, then exit non-zero on any failure.
async function smokeShot(file) {
  const pages = ["/dashboard", "/settings", "/auto-pilot"];
  const settle = (ms = 4000) => new Promise((r) => setTimeout(r, ms));
  const wc = () => tabs.active.view.webContents;
  let code = 0;
  const check = (name, ok, detail = "") => { console.log(`SMOKE ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) code = 1; };
  const shot = async (contents, name) => {
    try {
      const img = await contents.capturePage();
      const out = file.replace(/\.png$/i, `-${name}.png`);
      fs.writeFileSync(out, img.toPNG());
      console.log(`SMOKE shot -> ${out}`);
    } catch (e) {
      console.log(`SMOKE shot ${name} failed (${e && e.message})`);
    }
  };
  try {
    // Bundled tools actually run (ffmpeg renders, yt-dlp downloads).
    const health = await control("/api/desktop/health");
    console.log(`SMOKE health ${JSON.stringify(health)}`);
    check("bundled ffmpeg + yt-dlp", !!health.ok);

    // Settings round-trip through the real preload bridge + IPC + server.
    await wc().loadURL(`${APP_URL}/settings`);
    await settle();
    const probe = "smoke_" + crypto.randomBytes(6).toString("hex");
    const saved = await wc().executeJavaScript(`window.vybeDesktop.saveKeys({ GROQ_API_KEYS: "${probe}" })`);
    const onDisk = fs.readFileSync(keysFile);
    check("key saved + masked", saved.GROQ_API_KEYS?.set === true && saved.GROQ_API_KEYS.hint.startsWith("…"));
    check("key encrypted on disk", !onDisk.includes(probe));
    const cleared = await wc().executeJavaScript(`window.vybeDesktop.saveKeys({ GROQ_API_KEYS: "" })`);
    check("key cleared", cleared.GROQ_API_KEYS?.set === false);

    for (const p of pages) {
      await wc().loadURL(`${APP_URL}${p}`);
      await settle();
      const info = await wc().executeJavaScript("JSON.stringify({ bridge: !!window.vybeDesktop, h1: document.querySelector('h1')?.textContent ?? '' })");
      const { bridge, h1 } = JSON.parse(info);
      check(`page ${p}`, bridge && !!h1, h1);
      await shot(wc(), p.slice(1));
    }

    // ── Tabs ──
    const n0 = tabs.tabs.length;
    // A page asking for a new window (what Ctrl/middle-click and target=_blank do) → in-app tab.
    await wc().executeJavaScript(`window.open(${JSON.stringify(APP_URL + "/clips")}, "_blank"); true`);
    await settle(3000);
    check("window.open → new tab", tabs.tabs.length === n0 + 1 && tabs.active.title === "Clips", `${tabs.tabs.length} tabs, active "${tabs.active.title}"`);
    const bg = tabs.create(`${APP_URL}/calendar`, { activate: false });
    await settle(2500);
    check("background tab", tabs.tabs.length === n0 + 2 && tabs.active.title === "Clips" && bg.title === "Calendar");
    // History: dashboard → analytics in the active tab, then Back.
    await wc().loadURL(`${APP_URL}/analytics`);
    await settle(2500);
    check("can go back", tabs.state().canBack);
    tabs.back();
    await settle(2500);
    check("back navigates", wc().getURL().endsWith("/clips"), wc().getURL());
    tabs.forward();
    await settle(2500);
    check("forward navigates", wc().getURL().endsWith("/analytics"), wc().getURL());
    // Close + reopen.
    const before = tabs.tabs.length;
    tabs.close(bg.id);
    check("close tab", tabs.tabs.length === before - 1);
    tabs.reopenClosed();
    await settle(2500);
    check("reopen closed tab", tabs.tabs.length === before && tabs.active.title === "Calendar");
    // Real mouse clicks on the toolbar (mousedown + mouseup at the button's
    // position), the way a user closes a tab — not a function call.
    const click = async (selector, button = "left") => {
      const r = await tabs.toolbar.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      if (!r) return false;
      tabs.toolbar.webContents.sendInputEvent({ type: "mouseMove", x: r.x, y: r.y });
      tabs.toolbar.webContents.sendInputEvent({ type: "mouseDown", x: r.x, y: r.y, button, clickCount: 1 });
      await settle(80);
      tabs.toolbar.webContents.sendInputEvent({ type: "mouseUp", x: r.x, y: r.y, button, clickCount: 1 });
      await settle(600);
      return true;
    };
    check("tab bar hidden on loading screen", chromeDuringLoading === false);
    check("tab bar shown after load", tabs.chrome === true);
    let count = tabs.tabs.length;
    const activeTitle = tabs.active.title;
    check("click × on active tab closes it", (await click(".tab.active .close")) && tabs.tabs.length === count - 1 && !tabs.tabs.some((t) => t.title === activeTitle),
      `${count} → ${tabs.tabs.length} tabs`);
    count = tabs.tabs.length;
    const inactive = await tabs.toolbar.webContents.executeJavaScript("document.querySelectorAll('.tab:not(.active)').length");
    if (inactive > 0) {
      check("click × on a background tab closes it", (await click(".tab:not(.active) .close")) && tabs.tabs.length === count - 1, `${count} → ${tabs.tabs.length} tabs`);
    }
    tabs.create(`${APP_URL}/todos`, { activate: false });
    await settle(2000);
    count = tabs.tabs.length;
    check("middle-click closes a tab", (await click(".tab:not(.active)", "middle")) && tabs.tabs.length === count - 1, `${count} → ${tabs.tabs.length} tabs`);
    check("click + opens a tab", (await click("#add")) && tabs.tabs.length === count, `${tabs.tabs.length} tabs`);
    await settle(2500);
    // Toolbar renders the tabs.
    const toolbarTabs = await tabs.toolbar.webContents.executeJavaScript("document.querySelectorAll('.tab').length");
    check("toolbar shows tabs", toolbarTabs === tabs.tabs.length, `${toolbarTabs} in toolbar / ${tabs.tabs.length} open`);
    await shot(tabs.toolbar.webContents, "toolbar");
    await shot(wc(), "active-tab");
  } catch (e) {
    console.error("SMOKE FAIL:", e && e.message);
    code = 1;
  }
  quitting = true;
  if (server) server.kill();
  app.exit(code);
}

app.on("before-quit", () => { quitting = true; if (tabs && !process.env.VYBE_SMOKE_SHOT) tabs.save(); });
app.on("will-quit", () => { if (server) server.kill(); });
app.on("window-all-closed", (e) => e.preventDefault()); // stay in the tray
