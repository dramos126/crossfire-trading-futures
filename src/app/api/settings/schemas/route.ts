import { type NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";

/**
 * Discovery endpoint: lists every registered broker plugin alongside its
 * credential field schema and configured status. Lets the Settings page
 * render the broker list dynamically (each broker's form section is
 * built from its schema), so adding a new broker plugin is the only
 * change needed to expose new credential fields in the UI.
 */
export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;
  const schemas = brokerRegistry.allPlugins().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    isConfigured: p.isConfigured(),
    fields: p.credentialSchema(),
  }));
  return NextResponse.json(schemas);
}
