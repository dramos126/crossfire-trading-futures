import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Block dev-only routes unless explicitly enabled. The `/dev` page and
 * `/api/dev/*` handlers let us hand-craft Topstep API calls (raw contract/order
 * inspection, custom order placement) without going through the engine —
 * invaluable locally, foot-gun in prod. Default-off via env var so any
 * environment that doesn't explicitly opt in (e.g. a deployed prod)
 * is automatically safe. Local dev sets DEV_TOOLS_ENABLED=true in
 * .env.local to unlock. Returns 404 so the endpoints look like they don't
 * exist rather than advertising their presence.
 *
 * The matcher also covers the three first-run API routes —
 * /api/settings/setup, /api/settings/setup-prefill and
 * /api/settings/test-connection. These pass through unauthenticated so a
 * first run can prefill and Test Connection before any creds exist. Per-route
 * auth (creds-absent guard for the setup routes, body-or-token branch for
 * test-connection) is enforced inside the route handlers themselves.
 *
 * `/setup` is gone: first run is a state of /settings, which needs no
 * middleware entry because the page itself is not gated here.
 */
export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path.startsWith("/dev") || path.startsWith("/api/dev/")) {
    if (process.env.DEV_TOOLS_ENABLED !== "true") {
      return new NextResponse("Not Found", { status: 404 });
    }
  }
  // /api/settings/setup, /api/settings/setup-prefill, /api/auth pass
  // through. The matcher includes them so the middleware boundary is
  // explicit; the route's own logic is the only gate — and each closes once
  // the web sign-in account exists, except /api/auth, which then wants its
  // password. `/api/auth/logout` and `/api/auth/password` are not here:
  // they are gated like every other route.
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dev/:path*",
    "/api/dev/:path*",
    "/api/settings/setup",
    "/api/settings/setup-prefill",
    "/api/settings/test-connection",
    "/api/auth",
  ],
};
