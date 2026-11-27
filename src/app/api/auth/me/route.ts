import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name, plan: users.plan, createdAt: users.createdAt, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const { emailVerifiedAt, ...rest } = user;
  return NextResponse.json({ ...rest, emailVerified: !!emailVerifiedAt });
}
