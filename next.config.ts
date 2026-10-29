import type { NextConfig } from "next";

const QUIET_POLL_PATHS = [
  "/api/trades",
  "/api/positions",
  "/api/engine",
];

/**
 * What must never be copied into the standalone output on account of a
 * route that reads the working directory at runtime.
 *
 * `backtests/` was 55MB of run artifacts, `docs/` is 3.6MB of markdown and
 * `src/` is the uncompiled source — all three land in `.next/standalone`
 * when a route's trace cannot be bounded. The run-reader routes read
 * directory names that do not exist until a run has been written, so the
 * module tracer traces the project for them; this exclusion bounds those
 * two routes' lists and nothing else — `instrumentation.js` and most API
 * routes trace the whole project for a reason of their own, still open
 * (infra/README.md). The artifact root now defaults to the Databento
 * mount, outside the project entirely; `backtests/**` stays for the
 * repo-relative fallback root a box with no mount uses.
 */
const TRACING_DATA_EXCLUDES = [
  "backtests/**",
  "docs/**",
  "src/**",
  "scripts/**",
  "data/**",
  "docker/**",
  "*.tsbuildinfo",
  "eslint.config.mjs",
  "postcss.config.mjs",
  "vitest.config.ts",
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["localhost"],
  output: "standalone",
  devIndicators: false,
  // @microsoft/signalr uses CommonJS `require` at runtime for optional
  // transports. Next's server bundler can't resolve those dynamic requires,
  // so mark it external — Node will load it normally from node_modules at
  // runtime.
  serverExternalPackages: ["@microsoft/signalr"],
  // See TRACING_DATA_EXCLUDES. Excluded by content rather than
  // blanket-excluded, so a genuine runtime dependency added to these routes
  // later is still traced.
  outputFileTracingExcludes: {
    "/api/backtest/runs/**": TRACING_DATA_EXCLUDES,
    "/api/backtest/runs": TRACING_DATA_EXCLUDES,
  },
  logging: {
    incomingRequests: {
      ignore: QUIET_POLL_PATHS.map(
        (p) => new RegExp(`^${p.replace(/\//g, "\\/")}(\\?|$)`)
      ),
    },
  },
  async redirects() {
    return [
      {
        // The Deployments page is gone — the board at `/` is the deployment
        // surface. A bookmark or a stale tab lands somewhere useful rather
        // than on a 404.
        //
        // **Exact source, deliberately.** `/deployments/:id` is the drill-in
        // and is a real route; a wildcard here would swallow it, and it would
        // do so silently the moment that route lands.
        source: "/deployments",
        destination: "/",
        permanent: false,
      },
      // The Strategies page is gone — a playbook's own page describes it,
      // deploys it, tries settings and reads its saved runs. A playbook's key
      // is its strategy key, so an old detail link lands on the same module.
      {
        source: "/strategies",
        destination: "/playbooks",
        permanent: false,
      },
      {
        source: "/strategies/:key",
        destination: "/playbooks/:key",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
