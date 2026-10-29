/**
 * The Topstep tail, opt-in: `run --topstep-tail` and every `parity-day` run.
 *
 * Everything here is loaded lazily, after two things are in place, because
 * the provider's import graph reaches the database and the bundler-only
 * strategy registry at module load:
 *
 * - **A database the CLI owns.** `db/connection.ts` reads `TRADING_DB_PATH`
 *   once, at import, and the Topstep stack reads credentials (DB first, env
 *   second) and caches its token through it. `run` points it at a scratch
 *   file in a temp directory, so the CLI still never opens the operator's
 *   database; `parity-day` points it at its private copy of the snapshot.
 *   Either way the credential rows are absent, so the tail authenticates with
 *   `TOPSTEP_USERNAME` / `TOPSTEP_API_KEY` from the environment.
 * - **`require.context`** — see `node-require-context.ts`.
 *
 * The composition itself is `chainCacheWithTopstepTail` in `cached-bars.ts`,
 * the same one the in-app routes splice with; this file only opens a client
 * for it and names the contract.
 */
import { mkdtempSync, rmSync } from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";

import type { BarSource } from "@/lib/data/bar-source";
import type { TopstepBrokerPlugin } from "@/lib/brokers/topstep/index";
import type { TickerSymbol } from "@/lib/trading/domain";
import type { SpecTicker } from "@/lib/trading/contracts/contract-specs";
import { CliError, DayRefusal } from "./cli-error";
import { installNodeRequireContext } from "./node-require-context";

export const DB_PATH_VAR = "TRADING_DB_PATH";
const SCRATCH_DB_FILE = "scratch.db";
const TOPSTEP_PLUGIN_ID = "topstep";

export interface TopstepTail {
  /** The contract the tail reads — the one Topstep marks active now. */
  contractId: (ticker: SpecTicker) => Promise<string>;
  chain: (cache: BarSource, contractId: string) => BarSource;
}

/**
 * A temp directory removed at exit, for the scratch or copied database. The
 * process runs once and exits, so `exit` is the whole lifecycle.
 */
export function privateDbDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "crossfire-backtest-db-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Open the tail. `dbPath` is the database the Topstep stack may write its
 * token into; absent, a scratch file is made. Must run before anything in
 * this process imports `db/connection.ts`.
 */
export async function openTopstepTail(dbPath?: string): Promise<TopstepTail> {
  assertDbConnectionNotLoaded(moduleCache());
  process.env[DB_PATH_VAR] = dbPath ?? path.join(privateDbDir(), SCRATCH_DB_FILE);
  routeConsoleLogToStderr();
  installNodeRequireContext();

  const [{ brokerRegistry }, { ContractResolver }, { chainCacheWithTopstepTail }] =
    await Promise.all([
      import("@/lib/brokers/registry-singleton"),
      import("@/lib/brokers/topstep/contract-resolver"),
      import("@/lib/data/cached-bars"),
    ]);

  // The same narrowing `TopstepMarketDataProvider.plugin()` makes.
  const plugin = brokerRegistry.getPlugin(TOPSTEP_PLUGIN_ID) as TopstepBrokerPlugin | null;
  if (plugin == null || !plugin.isConfigured()) {
    throw new CliError(
      "--topstep-tail needs TOPSTEP_USERNAME and TOPSTEP_API_KEY in the environment (.env.local).",
    );
  }
  try {
    await plugin.initialize();
  } catch (err) {
    throw topstepUnreachable(err);
  }
  const client = plugin.getClient();
  if (client == null) throw topstepUnreachable(new Error("no client after initialize()"));
  const resolver = new ContractResolver(client);

  return {
    contractId: async (ticker) => {
      try {
        return (await resolver.resolve(`/${ticker}` satisfies TickerSymbol)).id;
      } catch (err) {
        throw topstepUnreachable(err);
      }
    },
    chain: chainCacheWithTopstepTail,
  };
}

export function topstepUnreachable(err: unknown): CliError {
  const detail = err instanceof Error ? err.message : String(err);
  return new DayRefusal(`Topstep is unreachable, so the bar tail cannot be read: ${detail}`);
}

const DB_CONNECTION_MODULE = path.join("src", "lib", "db", "connection.ts");

function moduleCache(): Record<string, unknown> {
  return (Module as unknown as { _cache: Record<string, unknown> })._cache;
}

/**
 * `db/connection.ts` reads `TRADING_DB_PATH` once, at import. Loaded before
 * this function set it, every write — the tail's token included — would go
 * to whatever path the environment named, which under `parity-day` is the
 * operator's snapshot.
 */
export function assertDbConnectionNotLoaded(cache: Record<string, unknown>): void {
  const loaded = Object.keys(cache).find((file) => file.endsWith(DB_CONNECTION_MODULE));
  if (loaded != null) {
    throw new Error(
      `${loaded} was imported before the Topstep tail opened, so it holds a database path ` +
        `the CLI did not choose. Import it only after openTopstepTail().`,
    );
  }
}

/**
 * The app's log pipe writes info lines with `console.log`; once the Topstep
 * stack loads they would land on stdout, which is the run directory and
 * nothing else.
 */
function routeConsoleLogToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}
