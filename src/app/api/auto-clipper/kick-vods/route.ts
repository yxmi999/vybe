import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { kickGet, parseKickSlug } from "@/lib/kick";

type KickChannel = {
  id: number;
  slug: string;
  user?: { username?: string; profile_pic?: string };
};

type KickVodItem = {
  session_title?: string;
  start_time?: string; // "2026-06-11 22:11:43" (UTC, no zone marker)
  duration?: number;   // milliseconds
  views?: number;
  is_live?: boolean;
  thumbnail?: string | { src?: string; srcset?: string } | null;
  video?: { uuid?: string; is_private?: boolean; is_pruned?: boolean | null };
};

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { channel } = await req.json();
  if (!channel || !String(channel).trim()) {
    return NextResponse.json({ error: "Enter a Kick channel" }, { status: 400 });
  }
  const slug = parseKickSlug(channel);
  if (!slug) return NextResponse.json({ error: "Enter a Kick channel" }, { status: 400 });

  try {
    const [chRes, vidsRes] = await Promise.all([
      kickGet(`v2/channels/${encodeURIComponent(slug)}`),
      kickGet(`v2/channels/${encodeURIComponent(slug)}/videos`),
    ]);
    if (chRes.status === 404) {
      return NextResponse.json({ error: `Channel "${slug}" not found on Kick` }, { status: 404 });
    }
    if (chRes.status === 403 || vidsRes.status === 403) {
      return NextResponse.json(
        { error: "Kick blocked the request (Cloudflare). Try again in a moment." },
        { status: 502 },
      );
    }
    if (!chRes.ok) throw new Error(`Kick returned ${chRes.status} for the channel lookup`);
    if (!vidsRes.ok) throw new Error(`Kick returned ${vidsRes.status} for the VOD list`);

    const ch = chRes.data as KickChannel;
    const items = (Array.isArray(vidsRes.data) ? vidsRes.data : []) as KickVodItem[];

    const vods = items
      .filter((v) => v.video?.uuid && !v.is_live && !v.video.is_private && v.start_time && (v.duration ?? 0) > 0)
      .map((v) => ({
        uuid: v.video!.uuid!,
        title: v.session_title || "Untitled stream",
        startTime: `${v.start_time!.replace(" ", "T")}Z`,
        durationSec: Math.round((v.duration ?? 0) / 1000),
        views: v.views ?? 0,
        thumbnail: typeof v.thumbnail === "string" ? v.thumbnail : v.thumbnail?.src ?? "",
      }));

    return NextResponse.json({
      channel: {
        id: ch.id,
        login: ch.slug || slug,
        displayName: ch.user?.username || slug,
        avatar: ch.user?.profile_pic || "",
      },
      vods,
    });
  } catch (err) {
    console.error("[auto-clipper/kick-vods]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load Kick VODs" },
      { status: 500 },
    );
  }
}
