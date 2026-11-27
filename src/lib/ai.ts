// Shared plumbing for the Gemini-backed routes (ai-edit, ai-title, …).

// Fallback chain — each model has its own capacity pool, so a 503
// ("high demand") on one usually succeeds immediately on the next.
// The 2.x models are closed to newer Google accounts ("no longer available to
// new users", 404) — keys from those accounts fall through to the 3.x models.
export const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"] as const;

// Pull an HTTP status out of AI SDK errors (APICallError, RetryError
// wrapping a lastError, nested causes) without relying on instanceof.
export function statusOf(err: unknown): number | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as { statusCode?: unknown; lastError?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof o.statusCode === "number") return o.statusCode;
    cur = o.lastError ?? o.cause ?? (Array.isArray(o.errors) ? o.errors[o.errors.length - 1] : undefined);
  }
  return undefined;
}

// Transient failures are worth handing to the next model in the chain;
// auth/config/bad-request errors are not.
export function isTransient(err: unknown): boolean {
  const status = statusOf(err);
  const msg = err instanceof Error ? err.message : String(err);
  // A model retired for this key → the next model in the chain may work.
  if (status === 404 && /no longer available|not found for api version|not supported for generatecontent/i.test(msg)) return true;
  if (status !== undefined) return status === 429 || status >= 500;
  return /overloaded|high demand|unavailable|rate limit|quota|timeout|timed out|fetch failed|network/i.test(msg);
}

/** Map the final error of a model-fallback loop to a user-facing message + status. */
export function aiFailure(lastErr: unknown): { error: string; status: number } {
  const status = statusOf(lastErr);
  if (status === 401 || status === 403) {
    return { error: "The Google AI API key was rejected. Check GOOGLE_GENERATIVE_AI_API_KEY in .env.local.", status: 500 };
  }
  if (isTransient(lastErr)) {
    return { error: "The AI service is busy right now. Give it a few seconds and try again.", status: 503 };
  }
  return { error: lastErr instanceof Error ? lastErr.message : "AI request failed", status: 500 };
}
