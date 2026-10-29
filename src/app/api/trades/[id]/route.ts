import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { deleteTrade, getTradeById } from "@/lib/db/trades";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid trade id" }, { status: 400 });
  }

  const trade = getTradeById(id);
  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  const inflight = trade.status === "pending_entry" || trade.status === "open" || trade.status === "pending_exit";
  if (inflight) {
    return NextResponse.json(
      { error: "Cannot delete an in-flight trade (pending_entry / open / pending_exit). Close the position first." },
      { status: 409 },
    );
  }

  const deleted = deleteTrade(id);
  if (!deleted) {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
