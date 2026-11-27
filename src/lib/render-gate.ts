// Global semaphore for CPU-heavy ffmpeg encodes. A single x264 encode already
// saturates every core, so running many at once doesn't add throughput — it
// just makes every render slower and stacks ffmpeg's memory. Heavy paths take
// a slot via withRenderSlot(); extra jobs wait FIFO. Cheap ffmpeg work
// (stream-copies, probes) should NOT take a slot.
//
// Limit comes from RENDER_CONCURRENCY (default 2 — right for ~4 vCPUs; raise
// it alongside the machine).

type Gate = { active: number; queue: (() => void)[] };

// Next.js can instantiate a lib module once per route bundle, which would give
// each route its own counter — hang the state off globalThis so every route
// shares one gate (same trick as a db-client singleton).
const g = globalThis as typeof globalThis & { __renderGate?: Gate };
const gate: Gate = (g.__renderGate ??= { active: 0, queue: [] });

const LIMIT = Math.max(1, Number(process.env.RENDER_CONCURRENCY) || 2);

function release(): void {
  const next = gate.queue.shift();
  // Hand the slot straight to the next waiter (active count unchanged), or
  // free it when nobody is waiting.
  if (next) next();
  else gate.active--;
}

export async function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (gate.active < LIMIT) gate.active++;
  else await new Promise<void>((resolve) => gate.queue.push(resolve));
  try {
    return await fn();
  } finally {
    release();
  }
}
