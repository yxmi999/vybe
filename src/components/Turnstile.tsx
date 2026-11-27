"use client";
// Cloudflare Turnstile widget, rendered explicitly so the page can reset it
// after each submit (tokens are single-use). Reports the current token via
// onToken: a string once solved, "" when it expires or errors.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "0x4AAAAAAGPTXRTvDA-iaq5o";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window { turnstile?: TurnstileApi }
}

let scriptLoad: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  scriptLoad ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptLoad = null; reject(new Error("Turnstile failed to load")); };
    document.head.appendChild(s);
  });
  return scriptLoad;
}

export type TurnstileHandle = { reset: () => void };

type Props = { action: string; onToken: (token: string) => void; className?: string };

const Turnstile = forwardRef<TurnstileHandle, Props>(function Turnstile({ action, onToken, className }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [error, setError] = useState("");

  const reset = useCallback(() => {
    onTokenRef.current("");
    setError("");
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }, []);
  useImperativeHandle(ref, () => ({ reset }), [reset]);

  useEffect(() => {
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !box.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(box.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          theme: "auto",
          size: "flexible",
          retry: "auto",
          "refresh-expired": "auto",
          callback: (t: string) => { setError(""); onTokenRef.current(t); },
          "expired-callback": () => onTokenRef.current(""),
          // Surface Cloudflare's error code so failures are diagnosable
          // (110200 = this domain isn't in the widget's hostname list).
          "error-callback": (code?: string) => {
            onTokenRef.current("");
            console.warn("[turnstile] error", code, "on", window.location.hostname);
            setError(code ? String(code) : "unknown");
          },
        });
      })
      .catch(() => { onTokenRef.current(""); setError("script-blocked"); });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [action]);

  return (
    <div>
      <div ref={box} className={className} />
      {error && (
        <p className="mt-1.5 text-[12px] text-red-400">
          {error === "script-blocked"
            ? "The human check couldn't load. Disable ad/script blockers for this site and reload."
            : error.startsWith("1102")
              ? `The human check isn't set up for ${window.location.hostname} (error ${error}).`
              : "brave" in navigator
                ? "Brave Shields blocked the human check. Click the lion icon in the address bar, turn Shields off for this site, then try again."
                : `The human check failed (error ${error}). Try disabling ad blockers or a VPN.`}{" "}
          <button type="button" onClick={reset} className="underline underline-offset-2">Try again</button>
        </p>
      )}
    </div>
  );
});

export default Turnstile;
