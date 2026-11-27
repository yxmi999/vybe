import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { kickGet, parseKickSlug } from "@/lib/kick";

type KickClip = {
  id: string;
  title: string;
  thumbnail_url: string;
  duration: number;
  created_at: string;
  view_count?: number;
  views?: number;
  creator?: { username?: string };
  channel?: { slug?: string };
};

type KickChannel = {
  slug: string;
  user?: { username?: string; profile_pic?: string };
};

// Kick buckets time as day/week/month/all — map our day counts onto them.
function timeBucket(days: number): string {
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "all";
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { channel, days = 7, limit = 20 } = await req.json();
  if (!channel || !String(channel).trim()) {
    return NextResponse.json({ error: "Enter a Kick channel" }, { status: 400 });
  }

  const slug = parseKickSlug(channel);
  if (!slug) return NextResponse.json({ error: "Enter a Kick channel" }, { status: 400 });

  const want = Math.max(1, Math.min(100, Number(limit) || 20));
  const time = timeBucket(Number(days) || 7);

  try {
    // ── Channel info ──
    const chRes = await kickGet(`v2/channels/${encodeURIComponent(slug)}`);
    if (chRes.status === 404) {
      return NextResponse.json({ error: `Channel "${slug}" not found on Kick` }, { status: 404 });
    }
    if (chRes.status === 403) {
      return NextResponse.json(
        { error: "Kick blocked the request (Cloudflare). Try again in a moment." },
        { status: 502 },
      );
    }
    if (!chRes.ok) throw new Error(`Kick returned ${chRes.status} for the channel lookup`);
    const ch = chRes.data as KickChannel;

    // ── Top clips (paginated, ~20 per page) ──
    const clips: KickClip[] = [];
    let cursor = "0";
    for (let page = 0; page < 5 && clips.length < want; page++) {
      const res = await kickGet(
        `v2/channels/${encodeURIComponent(slug)}/clips?cursor=${encodeURIComponent(cursor)}&sort=view&time=${time}`,
      );
      if (!res.ok) {
        if (clips.length > 0) break; // partial results beat an error
        if (res.status === 403) {
          return NextResponse.json(
            { error: "Kick blocked the request (Cloudflare). Try again in a moment." },
            { status: 502 },
          );
        }
        throw new Error(`Kick returned ${res.status} for clips`);
      }
      const data = res.data as { clips?: KickClip[]; nextCursor?: string };
      const batch = data.clips ?? [];
      clips.push(...batch);
      if (!data.nextCursor || batch.length === 0) break;
      cursor = data.nextCursor;
    }

    return NextResponse.json({
      channel: {
        login: ch.slug || slug,
        displayName: ch.user?.username || slug,
        avatar: ch.user?.profile_pic || "",
      },
      clips: clips.slice(0, want).map((c) => ({
        id: c.id,
        // The clip page URL — the editor's fetch route downloads these via yt-dlp.
        url: `https://kick.com/${ch.slug || slug}/clips/${c.id}`,
        title: c.title || "Untitled clip",
        view_count: c.view_count ?? c.views ?? 0,
        created_at: c.created_at,
        thumbnail_url: c.thumbnail_url || "",
        duration: c.duration || 0,
        creator_name: c.creator?.username || "",
      })),
    });
  } catch (err) {
    console.error("[auto-clipper/kick-top]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load Kick clips" },
      { status: 500 },
    );
  }
}
