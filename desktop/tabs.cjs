// Tabs for the desktop window — a small browser around the local app.
//
// The window is a BaseWindow holding a toolbar view (toolbar.html: back /
// forward / reload, the tab strip, +) and one WebContentsView per tab. Every
// tab is a fully independent page with its own history, so a long render can
// keep going in one tab while you work in another.
//
// Opening pages in tabs:
//   • Ctrl/Cmd+click or middle-click any in-app link (Next's <Link> leaves
//     modified clicks to the browser → window.open with a tab disposition).
//   • Right-click a link → "Open link in new tab"; right-click a page →
//     "Duplicate tab".
//   • Ctrl+T new tab, Ctrl+W close, Ctrl+Shift+T reopen closed, Ctrl+Tab /
//     Ctrl+Shift+Tab cycle, Ctrl+1…9 jump, Alt+←/→ back/forward,
//     Ctrl+R / F5 reload.
// Open tabs are saved on quit and restored on the next launch.
"use strict";
const { WebContentsView, Menu, clipboard, shell } = require("electron");
const fs = require("fs");

const TOOLBAR_HEIGHT = 42;
const MAX_TABS = 20;

// Friendly tab names for the app's pages (all pages share one <title>).
const PAGE_NAMES = {
  dashboard: "Dashboard", compose: "Compose", clips: "Clips", "auto-clipper": "Auto-Clipper",
  "auto-pilot": "Auto-Pilot", responses: "Auto-Respond", calendar: "Calendar", todos: "To-Do",
  analytics: "Analytics", accounts: "Accounts", settings: "Settings", billing: "Billing", studio: "Studio",
};

class Tabs {
  /**
   * @param {object} o
   * @param {import("electron").BaseWindow} o.win
   * @param {string} o.appUrl         local app origin, e.g. http://localhost:47321
   * @param {string} o.preload        app preload (Settings bridge)
   * @param {string} o.toolbarFile    toolbar.html
   * @param {string} o.toolbarPreload toolbar-preload.cjs
   * @param {string} o.stateFile      where open tabs are remembered
   */
  constructor(o) {
    Object.assign(this, o);
    this.tabs = [];
    this.activeId = null;
    this.closed = [];          // recently closed URLs, for Ctrl+Shift+T
    this.nextId = 1;
    // The toolbar stays hidden while the loading screen shows (full-window
    // splash); showChrome() reveals it once the app is up.
    this.chrome = false;

    this.toolbar = new WebContentsView({
      webPreferences: { preload: o.toolbarPreload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.toolbar.setBackgroundColor("#0d0d10");
    this.win.contentView.addChildView(this.toolbar);
    this.toolbar.setVisible(false);
    this.toolbar.webContents.loadFile(o.toolbarFile);
    this.toolbar.webContents.on("did-finish-load", () => this.push());
    this.toolbar.webContents.on("before-input-event", (e, input) => this.shortcut(e, input, null));

    this.win.on("resize", () => this.layout());
    this.win.on("maximize", () => this.layout());
    this.win.on("unmaximize", () => this.layout());
    this.layout();
  }

  get active() { return this.tabs.find((t) => t.id === this.activeId) ?? null; }

  isApp(url) { return url === this.appUrl || url.startsWith(this.appUrl + "/"); }

  titleFor(url) {
    if (!url || url.startsWith("file:") || url === "about:blank") return "Vybe";
    try {
      const u = new URL(url);
      if (!this.isApp(url)) return u.hostname.replace(/^www\./, "");
      const seg = u.pathname.split("/").filter(Boolean)[0] ?? "dashboard";
      return PAGE_NAMES[seg] ?? seg.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    } catch {
      return "Vybe";
    }
  }

  // ── Create / activate / close ────────────────────────────────────────────
  create(url, { activate = true, afterId = this.activeId, file = false } = {}) {
    if (this.tabs.length >= MAX_TABS) { this.activate(this.tabs[this.tabs.length - 1].id); return null; }
    const view = new WebContentsView({
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    view.setBackgroundColor("#0a0a0a");
    const tab = { id: this.nextId++, view, url, title: this.titleFor(url), loading: true };
    const at = this.tabs.findIndex((t) => t.id === afterId);
    this.tabs.splice(at >= 0 ? at + 1 : this.tabs.length, 0, tab);
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    this.wire(tab);
    tab.ready = file ? view.webContents.loadFile(url).catch(() => {}) : view.webContents.loadURL(url).catch(() => {});
    if (activate || !this.activeId) this.activate(tab.id); else this.push();
    this.layout();
    return tab;
  }

  activate(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.activeId = id;
    for (const t of this.tabs) t.view.setVisible(t.id === id);
    tab.view.webContents.focus();
    this.layout();
    this.push();
  }

  close(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    const url = tab.view.webContents.getURL();
    if (this.isApp(url)) this.closed.push(url);
    if (this.closed.length > 15) this.closed.shift();
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (this.tabs.length === 0) { this.create(`${this.appUrl}/dashboard`); return; }
    if (this.activeId === id) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    else this.push();
  }

  reopenClosed() {
    const url = this.closed.pop();
    if (url) this.create(url);
  }

  cycle(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length].id);
  }

  move(id, toIndex) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(this.tabs.length, toIndex)), 0, tab);
    this.push();
  }

  // ── Navigation (toolbar buttons) ──────────────────────────────────────────
  back() { const wc = this.active?.view.webContents; if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
  forward() { const wc = this.active?.view.webContents; if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }
  reload() { this.active?.view.webContents.reload(); }
  home() { this.active?.view.webContents.loadURL(`${this.appUrl}/dashboard`); }

  // ── Per-tab wiring ────────────────────────────────────────────────────────
  wire(tab) {
    const wc = tab.view.webContents;
    const update = () => {
      tab.url = wc.getURL();
      tab.title = this.titleFor(tab.url);
      if (tab.id === this.activeId) this.win.setTitle(tab.title === "Vybe" ? "Vybe" : `${tab.title} — Vybe`);
      this.push();
    };
    wc.on("did-start-loading", () => { tab.loading = true; this.push(); });
    wc.on("did-stop-loading", () => { tab.loading = false; update(); });
    wc.on("did-navigate", update);
    wc.on("did-navigate-in-page", update);  // client-side (Next router) navigations
    wc.on("page-title-updated", update);

    // Links that want a new window: in-app → a tab (background for
    // middle/Ctrl-click, foreground otherwise); other sites → the real browser.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (this.isApp(url)) this.create(url, { activate: disposition !== "background-tab", afterId: tab.id });
      else if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });

    wc.on("context-menu", (_e, p) => this.contextMenu(tab, p));
    wc.on("before-input-event", (e, input) => this.shortcut(e, input, tab));
  }

  contextMenu(tab, p) {
    const wc = tab.view.webContents;
    const items = [];
    if (p.linkURL) {
      if (this.isApp(p.linkURL)) {
        items.push({ label: "Open link in new tab", click: () => this.create(p.linkURL, { activate: false, afterId: tab.id }) });
      } else if (/^https?:\/\//.test(p.linkURL)) {
        items.push({ label: "Open link in browser", click: () => shell.openExternal(p.linkURL) });
      }
      items.push({ label: "Copy link address", click: () => clipboard.writeText(p.linkURL) }, { type: "separator" });
    }
    if (p.isEditable) {
      items.push(
        { role: "undo", enabled: p.editFlags.canUndo }, { role: "redo", enabled: p.editFlags.canRedo }, { type: "separator" },
        { role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy },
        { role: "paste", enabled: p.editFlags.canPaste }, { role: "selectAll" }, { type: "separator" },
      );
    } else if (p.selectionText) {
      items.push({ role: "copy" }, { type: "separator" });
    }
    items.push(
      { label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: "Reload", click: () => wc.reload() },
      { type: "separator" },
      { label: "Duplicate tab", enabled: this.isApp(wc.getURL()), click: () => this.create(wc.getURL(), { afterId: tab.id }) },
      { label: "New tab", accelerator: "CmdOrCtrl+T", click: () => this.create(`${this.appUrl}/dashboard`) },
    );
    Menu.buildFromTemplate(items).popup();
  }

  shortcut(e, input, tab) {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    const k = input.key;
    let handled = true;
    if (ctrl && !input.shift && k.toLowerCase() === "t") this.create(`${this.appUrl}/dashboard`);
    else if (ctrl && input.shift && k.toLowerCase() === "t") this.reopenClosed();
    else if (ctrl && k.toLowerCase() === "w") { if (this.activeId) this.close(this.activeId); }
    else if (ctrl && k === "Tab") this.cycle(input.shift ? -1 : 1);
    else if (ctrl && k === "PageDown") this.cycle(1);
    else if (ctrl && k === "PageUp") this.cycle(-1);
    else if (ctrl && /^[1-9]$/.test(k)) {
      const n = Number(k);
      const target = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
      if (target) this.activate(target.id);
    }
    else if (input.alt && k === "ArrowLeft") this.back();
    else if (input.alt && k === "ArrowRight") this.forward();
    else if (k === "F5" || (ctrl && k.toLowerCase() === "r")) this.reload();
    else if (ctrl && input.shift && k.toLowerCase() === "i" && !require("electron").app.isPackaged) (tab ?? this.active)?.view.webContents.toggleDevTools();
    else handled = false;
    if (handled) e.preventDefault();
  }

  // ── Layout + toolbar state ────────────────────────────────────────────────
  showChrome() {
    if (this.chrome) return;
    this.chrome = true;
    this.toolbar.setVisible(true);
    this.layout();
    this.push();
  }

  layout() {
    const { width, height } = this.win.getContentBounds();
    const top = this.chrome ? TOOLBAR_HEIGHT : 0;
    this.toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
    const body = { x: 0, y: top, width, height: Math.max(0, height - top) };
    for (const t of this.tabs) t.view.setBounds(body);
  }

  state() {
    const a = this.active;
    const wc = a?.view.webContents;
    return {
      activeId: this.activeId,
      canBack: !!wc?.navigationHistory.canGoBack(),
      canForward: !!wc?.navigationHistory.canGoForward(),
      canReopen: this.closed.length > 0,
      tabs: this.tabs.map((t) => ({ id: t.id, title: t.title, loading: t.loading, app: this.isApp(t.url) || t.url.startsWith("file:") })),
    };
  }

  push() {
    if (!this.toolbar.webContents.isDestroyed()) this.toolbar.webContents.send("tabs:state", this.state());
  }

  /** Toolbar → main. Only the toolbar's own page may drive the tabs. */
  command(cmd) {
    switch (cmd?.type) {
      case "activate": return this.activate(cmd.id);
      case "close": return this.close(cmd.id);
      case "new": return this.create(`${this.appUrl}/dashboard`);
      case "back": return this.back();
      case "forward": return this.forward();
      case "reload": return this.reload();
      case "home": return this.home();
      case "reopen": return this.reopenClosed();
      case "move": return this.move(cmd.id, cmd.index);
      case "menu": return this.tabMenu(cmd.id);
    }
  }

  tabMenu(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const url = tab.view.webContents.getURL();
    Menu.buildFromTemplate([
      { label: "New tab", click: () => this.create(`${this.appUrl}/dashboard`, { afterId: id }) },
      { label: "Duplicate", enabled: this.isApp(url), click: () => this.create(url, { afterId: id }) },
      { label: "Reload", click: () => tab.view.webContents.reload() },
      { type: "separator" },
      { label: "Close tab", click: () => this.close(id) },
      { label: "Close other tabs", enabled: this.tabs.length > 1, click: () => { for (const t of [...this.tabs]) if (t.id !== id) this.close(t.id); } },
      { label: "Reopen closed tab", enabled: this.closed.length > 0, click: () => this.reopenClosed() },
    ]).popup();
  }

  // ── Session restore ───────────────────────────────────────────────────────
  save() {
    try {
      const urls = this.tabs.map((t) => t.view.webContents.getURL()).filter((u) => this.isApp(u));
      const active = this.tabs.findIndex((t) => t.id === this.activeId);
      fs.writeFileSync(this.stateFile, JSON.stringify({ urls, active: Math.max(0, active) }));
    } catch { /* best effort */ }
  }

  saved() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      const urls = (Array.isArray(s.urls) ? s.urls : []).filter((u) => typeof u === "string" && this.isApp(u)).slice(0, MAX_TABS);
      return urls.length ? { urls, active: Number(s.active) || 0 } : null;
    } catch {
      return null;
    }
  }

  /** Reload every tab (after the local server restarted). */
  reloadAll() { for (const t of this.tabs) if (this.isApp(t.view.webContents.getURL())) t.view.webContents.reload(); }

  /** App-wide page relative path for a tab id (test helper). */
  urlOf(id) { return this.tabs.find((t) => t.id === id)?.view.webContents.getURL() ?? ""; }
}

module.exports = { Tabs, TOOLBAR_HEIGHT };
