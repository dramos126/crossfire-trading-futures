/**
 * How many REST requests this process sent Topstep since the last read, per
 * path, and how many it refused for rate (429). The engine logs a lookup
 * that failed, never the volume that made it fail, so a 429 storm could not
 * say whether the engine was over Topstep's limit or something else on the
 * same login was. The heartbeat reads and resets this once a window.
 *
 * On `globalThis` for the reason `topstepSessionState` is: the
 * instrumentation hook and the route handlers can load this directory in
 * separate module graphs, and the web app's calls share the engine's limit.
 */

const API_PATH_PREFIX = "/api/";
const RATE_LIMITED_STATUS = 429;

interface PathCount {
  sent: number;
  rateLimited: number;
}

const REQUEST_COUNTS_KEY = "__topstepRequestCounts__" as const;
type GlobalWithCounts = typeof globalThis & { [REQUEST_COUNTS_KEY]?: Map<string, PathCount> };

function counts(): Map<string, PathCount> {
  const g = globalThis as GlobalWithCounts;
  g[REQUEST_COUNTS_KEY] ??= new Map();
  return g[REQUEST_COUNTS_KEY];
}

function countFor(path: string): PathCount {
  const all = counts();
  let c = all.get(path);
  if (!c) {
    c = { sent: 0, rateLimited: 0 };
    all.set(path, c);
  }
  return c;
}

export function noteTopstepRequest(path: string): void {
  countFor(path).sent++;
}

export function noteTopstepResponse(path: string, status: number): void {
  if (status === RATE_LIMITED_STATUS) countFor(path).rateLimited++;
}

/**
 * The window so far as one heartbeat fragment, then zeroed:
 * `rest 62/win, 3 refused (Position/searchOpen 30 ×3, Order/searchOpen 22, …)`.
 * Busiest path first; `×n` is that path's 429s.
 */
export function takeTopstepRequestWindow(): string {
  const all = counts();
  const rows = [...all.entries()].sort((a, b) => b[1].sent - a[1].sent);
  all.clear();
  const sent = rows.reduce((n, [, c]) => n + c.sent, 0);
  const refused = rows.reduce((n, [, c]) => n + c.rateLimited, 0);
  if (sent === 0) return "rest 0/win";
  const perPath = rows
    .map(([path, c]) => {
      const name = path.startsWith(API_PATH_PREFIX) ? path.slice(API_PATH_PREFIX.length) : path;
      return c.rateLimited > 0 ? `${name} ${c.sent} ×${c.rateLimited}` : `${name} ${c.sent}`;
    })
    .join(", ");
  return `rest ${sent}/win, ${refused} refused (${perPath})`;
}
