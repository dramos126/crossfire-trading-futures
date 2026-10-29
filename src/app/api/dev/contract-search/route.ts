import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getTopstepClientIfConfigured } from "@/lib/trading/engine/engine-singleton";
import type { Broker } from "@/lib/trading/broker-access/broker";

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: { searchText?: string; live?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const searchText = (body.searchText ?? "").trim();
  if (!searchText) return NextResponse.json({ error: "searchText required" }, { status: 400 });

  const broker: Broker | null = await getTopstepClientIfConfigured();
  if (!broker) {
    return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
  }

  try {
    const contracts = await broker.searchContracts(searchText, body.live ?? false);
    return NextResponse.json({ contracts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
