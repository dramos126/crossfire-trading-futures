/**
 * `GET /api/backtest/runs` — the index of CLI run artifacts on disk.
 *
 * Read-only, and deliberately says nothing about how a run was produced
 * beyond what its own header records. The trader agent owns the CLI; this
 * route never starts one.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { listRuns } from "@/lib/trading/backtest-artifacts";

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  try {
    return NextResponse.json({ runs: await listRuns() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the backtest runs folder" },
      { status: 500 },
    );
  }
}
