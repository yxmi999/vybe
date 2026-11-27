import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getServerSession } from "@/lib/auth";
import { createJob, runJob, getJobHandler, getJobForUser } from "@/lib/jobs";
import { withCors, corsPreflight } from "@/lib/cors";
// Side-effect import: registers every job handler. Must not be imported from
// jobs.ts itself — ESM hoisting would run registerJob() before `registry` exists.
import "@/lib/jobs.register";

// One dynamic segment serves both job endpoints, because Next.js does not allow
// sibling dynamic folders with different slug names ([id] vs [type]):
//   POST /api/jobs/{type}  -> create + run a job, segment is the job type
//   GET  /api/jobs/{id}    -> poll a job, segment is the numeric job id

export async function OPTIONS() {
  return corsPreflight();
}

// Mobile calls this instead of a long-running AI-assist route directly, then
// polls GET /api/jobs/[id]. The actual work runs in `after()` — post-response,
// via Vercel's waitUntil — so this handler returns as soon as the job row exists.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return withCors(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

  const { id: type } = await params;
  if (!getJobHandler(type)) {
    return withCors(NextResponse.json({ error: `Unknown job type: ${type}` }, { status: 404 }));
  }

  const input = await req.json().catch(() => ({}));
  const job = await createJob(session.userId, type, input);

  after(() => runJob(job.id, type, input, session.userId));

  return withCors(NextResponse.json({ jobId: job.id, status: job.status }, { status: 202 }));
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return withCors(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isFinite(jobId)) {
    return withCors(NextResponse.json({ error: "Invalid job id" }, { status: 400 }));
  }

  const job = await getJobForUser(jobId, session.userId);
  if (!job) return withCors(NextResponse.json({ error: "Not found" }, { status: 404 }));

  return withCors(NextResponse.json({
    id: job.id,
    type: job.type,
    status: job.status,
    result: job.result ? JSON.parse(job.result) : null,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }));
}

export const maxDuration = 300;
