"use client";
// Light / dark theme. The theme is a class on <html> ("light" = light, none =
// dark, the default), persisted in localStorage. THEME_INIT_SCRIPT (in
// theme-script.ts) applies it before first paint so there's no flash.
import { useSyncExternalStore } from "react";
import { THEME_KEY } from "./theme-script";

export type Theme = "dark" | "light";

const listeners = new Set<() => void>();

function current(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

export function setTheme(t: Theme) {
  document.documentElement.classList.toggle("light", t === "light");
  try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // Keep tabs in sync.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_KEY) return;
    document.documentElement.classList.toggle("light", e.newValue === "light");
    cb();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, current, () => "dark" as Theme);
  return [theme, setTheme];
}
