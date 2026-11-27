// Direct-to-Blob uploads for the hosted site.
//
// Vercel functions reject request bodies over 4.5 MB, so videos can't be
// POSTed through /api/upload or /api/clips/upload in production. Instead the
// browser uploads straight to Vercel Blob (lib/upload-client.ts) and this
// route only:
//   • authorizes each upload (signed-in user, allowed media types, 500 MB
//     cap, the monthly clip quota for imports) before Blob issues a short-
//     lived client token, and
//   • records the finished clip in the ledger when Vercel Blob calls back.
// GET tells the client whether direct uploads are available (they need
// BLOB_READ_WRITE_TOKEN; locally and in the desktop app the old routes are used).
import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getServerSession } from "@/lib/auth";
import { checkClipQuota, checkSideUploadAllowance, MEDIA_TTL_DAYS, quotaMessage, recordClip } from "@/lib/plan";

export const maxDuration = 60;

// "upload" = a clip imported into the editor (counts toward the quota),
// "export" = a re-upload of an already-counted clip, "media" = post
// attachments (compose / calendar), not ledgered — same rules as the old routes.
type Kind = "upload" | "export" | "media";
const KINDS: Kind[] = ["upload", "export", "media"];

export async function GET() {
  return NextResponse.json({ direct: !!process.env.BLOB_READ_WRITE_TOKEN });
}

export async function POST(req: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "Direct uploads aren't configured." }, { status: 501 });
  }
  const body = (await req.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request: req,
      // Runs for the browser's token request (has the session cookie).
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        const session = await getServerSession();
        if (!session) throw new Error("Unauthorized");
        let kind: Kind = "upload";
        try {
          const k = JSON.parse(clientPayload ?? "{}").kind;
          if (KINDS.includes(k)) kind = k;
        } catch { /* default */ }
        if (kind === "upload") {
          const quota = await checkClipQuota(session.userId);
          if (!quota.allowed) throw new Error(quotaMessage(quota));
        } else {
          // The client picks the kind, so the quota-free kinds get their own cap.
          const side = await checkSideUploadAllowance(session.userId, kind);
          if (!side.allowed) throw new Error(side.message);
        }
        return {
          allowedContentTypes: ["video/*", "audio/*", "image/*"],
          maximumSizeInBytes: 500 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId: session.userId, kind }),
        };
      },
      // Called by Vercel Blob (signed — verified by handleUpload) once the
      // file is stored. Not reachable on localhost, which never uses this path.
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const { userId, kind } = JSON.parse(tokenPayload ?? "{}") as { userId?: number; kind?: Kind };
        if (!userId) return;
        if (kind === "media") {
          // Ledgered so it counts toward the media cap and gets cleaned up.
          await recordClip({ userId, url: blob.url, kind: "media", countsQuota: false, minTtlDays: MEDIA_TTL_DAYS });
          return;
        }
        await recordClip({ userId, url: blob.url, kind: kind === "export" ? "export" : "upload", countsQuota: kind !== "export" });
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}
