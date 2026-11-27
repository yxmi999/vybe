// Client-side view of the desktop app's preload bridge (desktop/preload.cjs).
// `window.vybeDesktop` only exists inside the Electron app, so its presence is
// how the UI knows it's running as the desktop version.
import { useSyncExternalStore } from "react";
export type DesktopKeyState = { set: boolean; hint: string };

export type DesktopInfo = {
  version: string;
  dataDir: string;
  appUrl: string;
};

export type VybeDesktop = {
  getKeys: () => Promise<Record<string, DesktopKeyState>>;
  /** name → new value ("" clears it). Names not included are left alone. */
  saveKeys: (values: Record<string, string>) => Promise<Record<string, DesktopKeyState>>;
  getInfo: () => Promise<DesktopInfo>;
  openDataDir: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
};

declare global {
  interface Window { vybeDesktop?: VybeDesktop }
}

export function desktopBridge(): VybeDesktop | null {
  return typeof window !== "undefined" ? window.vybeDesktop ?? null : null;
}

// Hydration-safe "am I in the desktop app?" — false on the server render,
// the real answer on the client (the bridge never appears/disappears later).
const noSubscribe = () => () => {};
export function useIsDesktop(): boolean {
  return useSyncExternalStore(noSubscribe, () => !!window.vybeDesktop, () => false);
}
