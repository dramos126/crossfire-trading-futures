import { brokerRegistry } from "@/lib/brokers/registry-singleton";

/**
 * The Topstep browser JWT, sourced from the server's own plugin.
 *
 * Routes used to read this out of a request header — which the browser
 * had itself received from `/api/auth` moments earlier.
 * The server has held the token the whole time; the round-trip through the
 * browser added nothing but a hard dependency on Topstep being the broker
 * that logged you in.
 *
 * Returns `null` when Topstep is not configured. Callers must handle that
 * rather than passing it into `setToken` — on a Tradovate-only install
 * there is no Topstep JWT and there never will be. Throws when Topstep is
 * configured but its gateway rejects us, which is an upstream failure and
 * belongs in the caller's existing catch arm.
 */
export async function topstepBrowserToken(): Promise<string | null> {
  const plugin = brokerRegistry.getPlugin("topstep");
  if (!plugin) return null;
  return plugin.getBrowserToken();
}
