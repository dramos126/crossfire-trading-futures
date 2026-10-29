import type { MainSession, ParamValues, StrategyModule } from "../strategy-types";
import {
  daySessionRefusalFor,
  instrumentRefusalFor,
  resolveDeploymentParams,
} from "../strategy-types";
import { crossTimeframeExitRefusalFor, type AllFilterParams } from "../filters";
import { registerFromContext, type StrategyContext } from "./registry-core";

// Webpack's require.context scans the filesystem at build time. The folder a
// playbook sits in is what decides which builds hold it: `prod/` every build,
// `staging/` and `test/` staging only, `wip/` and `retired/` none — those are
// for the backtest CLI and the tests (`load-node.ts`), and no context below
// points at either. The
// strategy key is derived from the FILENAME (without `.strategy.ts`), not the
// directory path, so moving a playbook between folders never changes its key.
declare const require: {
  context(path: string, deep: boolean, filter: RegExp): StrategyContext;
};

export const STRATEGIES: Record<string, StrategyModule> = {};

// One context per folder, and never two on one directory: Turbopack keys a
// context module on its directory and `deep` flag, not its regex, so two calls
// on `"./"` shared one module id and the runtime installed only the first map —
// staging registered `prod/` alone from 2026-10-12 to 2026-10-21. The directory
// argument is what decides which files enter the bundle, so it must stay a
// literal; `registry.test.ts` pins one directory per call.
//
// Every build: `prod/`.
registerFromContext(STRATEGIES, require.context("./prod", true, /\.strategy\.ts$/), "./prod");

// Staging adds `staging/` and `test/`.
//
// Gate must be a literal `process.env.NEXT_PUBLIC_*` string-equality
// check, NOT the `isStagingEnv()` helper. Next/Turbopack only
// constant-folds direct NEXT_PUBLIC_* reads at build time — wrapping
// the read in a function call defeats the fold and leaves the
// require.context call live in the prod bundle, which (a) leaks every
// staging-only module into prod's output and (b) lets a runtime env flip
// activate them. Keep this read raw.
if (process.env.NEXT_PUBLIC_APP_ENV === "staging") {
  registerFromContext(STRATEGIES, require.context("./staging", true, /\.strategy\.ts$/), "./staging");
  registerFromContext(STRATEGIES, require.context("./test", true, /\.strategy\.ts$/), "./test");
}

export function getStrategy(key: string): StrategyModule | undefined {
  return STRATEGIES[key];
}

/** Every key this build registered, hidden and test modules included — what
 *  boot checks against `PROD_PLAYBOOK_KEYS`. Not `listStrategies()`, which is
 *  the picker's filtered list. */
export function registeredStrategyKeys(): string[] {
  return Object.keys(STRATEGIES);
}

/**
 * The trading window a `strategyKey` names, or `null` when no module is
 * registered under it.
 *
 * It reads `config.session` and nothing else. Every surface that used to parse
 * a `mainSession` out of a row's `paramValues` resolves it from the
 * `strategyKey` now — the deploy-time conflict check, both deployment routes,
 * the group routes and `add-legs`, and `filterMainSessionOverlaps` — so a
 * deployment cannot describe a window the engine will not run.
 *
 * Every one of those callers is server-side. It lives here rather than beside
 * them because it needs the registry and nothing else, and a copy in
 * `db/deployments.ts` would tie a pure lookup to `better-sqlite3`. The board
 * and the trades export do not call it at all — they take the session as an
 * argument, because the registry is a build-time `require.context` with no
 * test-environment equivalent (design-language.md, *The Dashboard board's view
 * model*).
 */
export function sessionForStrategyKey(key: string): MainSession | null {
  return STRATEGIES[key]?.config.session ?? null;
}

/**
 * The cross-instrument refusal sentence for a `(strategyKey, ticker)` pair, or
 * `null` when the pair is admissible.
 *
 * Same shape and the same reason as `sessionForStrategyKey` above: the
 * declaration is on the module, the callers are the server-side create routes,
 * and a copy in `db/deployments.ts` would tie a registry lookup to
 * `better-sqlite3`. An unregistered key answers `null` — the routes already
 * refuse one on its own line, and a second sentence about a module that is not
 * there would be guessing at what it declares.
 *
 * The deploy modal does not call it: the client already holds the module's
 * `config` and asks `instrumentRefusalFor` directly, for the reason the board
 * takes its session as an argument.
 */
export function instrumentRefusalForStrategyKey(key: string, ticker: string): string | null {
  const mod = STRATEGIES[key];
  return mod ? instrumentRefusalFor(mod.config, ticker) : null;
}

/**
 * The day-session refusal sentence for a `(strategyKey, ticker)` pair, or
 * `null` when the pair is admissible.
 *
 * Same shape as `instrumentRefusalForStrategyKey` above and the same reason:
 * the declaration (`config.requiresDaySession`) is on the module, the callers
 * are the server-side create routes, and a copy in `db/deployments.ts` would
 * tie a registry lookup to `better-sqlite3`. An unregistered key answers
 * `null` for the same reason — the routes already refuse one on its own
 * line.
 *
 * The deploy modal does not call it either, and for the same reason: the
 * client already holds the module's `config` and asks `daySessionRefusalFor`
 * directly.
 */
export function daySessionRefusalForStrategyKey(key: string, ticker: string): string | null {
  const mod = STRATEGIES[key];
  return mod ? daySessionRefusalFor(mod.config, ticker) : null;
}

/**
 * The cross-timeframe exit-filter refusal sentence for a `(strategyKey,
 * paramValues)` pair, or `null` when the pair is admissible.
 *
 * Takes params rather than a ticker, and that is the whole difference from the
 * two above: this condition is operator-set, so it is not answerable off
 * `config` and it does not stop changing once the row exists. The routes that
 * write params — both create routes and the group PATCH — ask it here, and the
 * engine asks `crossTimeframeExitRefusalFor` again at every sync, because a
 * saved row that predates this check reaches activation without passing one.
 *
 * Merged through `resolveDeploymentParams`, the same helper the engine and the
 * backtest merge with: the enable key defaults to `false` on the schema, so a
 * blob that names neither key must resolve to the module's defaults rather than
 * to an absent one, or a module shipping the filter on would create cleanly and
 * be refused at activation instead.
 */
export function crossTimeframeExitRefusalForStrategyKey(
  key: string,
  paramValues: ParamValues | undefined,
): string | null {
  const mod = STRATEGIES[key];
  if (!mod) return null;
  const params = resolveDeploymentParams(mod, paramValues, { strategyKey: key });
  return crossTimeframeExitRefusalFor(params as unknown as AllFilterParams);
}

/**
 * The operator's listing surface, and the only consumer of `config.hidden`.
 *
 * `getStrategy(key)` is deliberately unfiltered, and so is the CLI's
 * `load-node.ts`: a hidden module still deploys, backtests, replays and runs
 * from `--playbook`. Hiding is about what the picker offers, never about what
 * the platform can load — `opening-range-breakout-v2` is `orb`'s measured
 * baseline and every number in `orb`'s README depends on it staying runnable.
 * What a build can load at all is the folder contexts above, which is a
 * different question decided at build time.
 */
export function listStrategies(): { key: string; module: StrategyModule }[] {
  return Object.entries(STRATEGIES)
    .filter(([, module]) => !module.config.hidden)
    .map(([key, module]) => ({ key, module }))
    .sort((a, b) => a.module.config.name.localeCompare(b.module.config.name));
}
