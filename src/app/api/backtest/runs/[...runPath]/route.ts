/**
 * `GET /api/backtest/runs/<playbook>/<run>` — one run's header and trades.
 *
 * The catch-all segment is the run's path relative to the artifact root,
 * which is how the index names it. `resolveRunDir` does the containment
 * check on the *resolved* path — see its comment for why a `..` scan is not
 * that check — and a path that escapes answers 404 rather than 403: a
 * traversal attempt and a run that is not there are the same fact to the
 * only caller that legitimately exists.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { readRun } from "@/lib/trading/backtest-artifacts";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runPath: string[] }> },
) {
  const denied = requireSession(request);
  if (denied) return denied;

  const { runPath } = await params;
  const joined = runPath.map((s) => decodeURIComponent(s)).join("/");

  try {
    const run = await readRun(joined);
    if (run == null) {
      return NextResponse.json({ error: "No backtest run at that path" }, { status: 404 });
    }
    return NextResponse.json(run);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read that backtest run" },
      { status: 500 },
    );
  }
}
