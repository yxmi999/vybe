import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { jobs } from "./schema";

// Generic async job envelope: the mobile app POSTs to /api/jobs/{type} and
// polls GET /api/jobs/{id} instead of holding a foreground request open for
// the 120-300s some AI-assist routes can take. `type` -> handler is a plain
// in-process registry; each existing route's core logic gets wrapped once,
// not rewritten.
export type JobHandler = (input: unknown, ctx: { userId: number }) => Promise<unknown>;

const registry = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler) {
  registry.set(type, handler);
}

export function getJobHandler(type: string) {
  return registry.get(type);
}

export async function createJob(userId: number, type: string, input: unknown) {
  const [row] = await db
    .insert(jobs)
    .values({ userId, type, status: "queued", input: JSON.stringify(input ?? null) })
    .returning();
  return row;
}

// Runs the registered handler and persists the outcome. Called from
// next/server's `after()` so it executes post-response on Vercel (via
// waitUntil) while still returning the jobId to the client immediately.
export async function runJob(jobId: number, type: string, input: unknown, userId: number) {
  const handler = getJobHandler(type);
  const now = () => new Date().toISOString();

  if (!handler) {
    await db.update(jobs).set({ status: "error", error: `Unknown job type: ${type}`, updatedAt: now() }).where(eq(jobs.id, jobId));
    return;
  }

  await db.update(jobs).set({ status: "running", updatedAt: now() }).where(eq(jobs.id, jobId));
  try {
    const result = await handler(input, { userId });
    await db.update(jobs).set({ status: "done", result: JSON.stringify(result), updatedAt: now() }).where(eq(jobs.id, jobId));
  } catch (err) {
    console.error(`[jobs:${type}]`, err);
    await db.update(jobs).set({
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      updatedAt: now(),
    }).where(eq(jobs.id, jobId));
  }
}

export async function getJobForUser(jobId: number, userId: number) {
  const [row] = await db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.userId, userId))).limit(1);
  return row ?? null;
}
