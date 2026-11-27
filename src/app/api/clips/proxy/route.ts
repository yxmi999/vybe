import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });

  const url = req.nextUrl.searchParams.get("url");
  if (!url || !url.startsWith("http")) return new NextResponse("Invalid url", { status: 400 });

  const upstream = await fetch(url);
  if (!upstream.ok || !upstream.body) return new NextResponse("Upstream error", { status: 502 });

  const contentType = upstream.headers.get("content-type") ?? "video/mp4";
  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
