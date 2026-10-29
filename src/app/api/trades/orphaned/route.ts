import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getOrphanedTradeGroups } from "@/lib/db/trades";

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  try {
    const groups = getOrphanedTradeGroups();
    return NextResponse.json({ groups });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load orphaned trades" },
      { status: 500 },
    );
  }
}
