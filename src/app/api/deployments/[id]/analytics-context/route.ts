import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getDeployment } from "@/lib/db/deployments";
import { engineHandle } from "@/lib/trading/engine/handle/select";

const handle = engineHandle();

/**
 * Analytics exclusion context: the current engine session UUID and the
 * deployment's current `version`. The analytics panel fetches this on mount
 * and uses it to exclude trades whose stamped engine_session_id /
 * deployment_version_id don't match (null-as-include — trades that predate
 * stamping flow through unchanged).
 *
 * Returns null engineSessionId when the engine hasn't booted in this
 * process yet (e.g. a fresh container that no browser has touched). The
 * panel treats null as "no current session to exclude against" and only
 * applies the deployment-version filter.
 */
interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const deployment = getDeployment(id);
  if (!deployment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    engineSessionId: await handle.engineSessionId(),
    deploymentVersion: String(deployment.version),
  });
}
