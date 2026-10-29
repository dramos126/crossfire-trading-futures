import type { StrategyModule } from "../strategy-types";
import { COMMON_PARAMS } from "../strategy-types";

/**
 * `timeframe` is the one CommonParams key whose default lives on `config`
 * rather than on the static COMMON_PARAMS schema. Walk the merged params at
 * registration and overwrite it from config so the form, backtest, and engine
 * all see the right baseline before any user edits.
 *
 * `size` was the second, and went with `config.size` when the risk sizer
 * became the only thing that answers a contract count.
 */
export function applyConfigDefaults(mod: StrategyModule): StrategyModule["params"] {
  const next = { ...mod.params };
  if (next.timeframe && next.timeframe.type === "select") {
    next.timeframe = { ...next.timeframe, default: mod.config.timeframe };
  }
  return next;
}

/** The slice of webpack's `require.context` the registry reads. */
export interface StrategyContext {
  keys(): string[];
  (id: string): { default: StrategyModule };
}

const TEST_SUBTREE_PREFIX = "./test/";

/** The file each key in a registry came from, so a second context can tell a
 *  re-listed file from a collision. */
const ORIGINS = new WeakMap<Record<string, StrategyModule>, Map<string, string>>();

/**
 * Register every module `context` holds that `into` does not already hold.
 *
 * `dir` is the directory the context was opened on (`"./prod"`), because a
 * context's keys are relative to it; every path below is `dir` joined to the
 * key, so the strategies-root-relative path is what is stamped and compared.
 *
 * Separate from `index.ts` so the registration itself can be run under vitest
 * against a context built from the filesystem — `require.context` exists only
 * inside the bundler. A module under `./test/` is stamped `isTest`, because
 * this is the only code that knows which path a module came from; the UI needs
 * a stamp rather than a sentence, since "never deploy live" in a description is
 * prose nobody reads at the moment they are picking one.
 *
 * A key already held from the same file is skipped. The same key from a
 * different file throws — the filename-key rule forbids it, and skipping would
 * let whichever context ran first decide silently which module trades under
 * that key.
 */
export function registerFromContext(
  into: Record<string, StrategyModule>,
  context: StrategyContext,
  dir: string,
): void {
  let origins = ORIGINS.get(into);
  if (!origins) {
    origins = new Map();
    ORIGINS.set(into, origins);
  }
  for (const id of context.keys()) {
    const file = `${dir.replace(/\/$/, "")}/${id.replace(/^\.\//, "")}`;
    const match = file.match(/([^/]+)\.strategy\.ts$/);
    if (!match) continue;
    const key = match[1];
    if (Object.hasOwn(into, key)) {
      const first = origins.get(key);
      if (first === file) continue;
      throw new Error(`Strategy key "${key}" is registered from both ${first ?? "(unknown)"} and ${file}.`);
    }
    origins.set(key, file);
    const mod = context(id).default;
    validateStrategy(key, mod);
    const isTest = file.startsWith(TEST_SUBTREE_PREFIX);
    into[key] = {
      ...mod,
      key,
      ...(isTest ? { isTest: true } : {}),
      params: applyConfigDefaults(mod),
    };
  }
}

/**
 * Fail-fast at registration if a strategy is missing required structure.
 * Every strategy must go through `withCommonParams(...)` so the UI, backtest,
 * and live engine see the same schema — without this, a missing `pauseWindows`
 * or `cooldownSeconds` wouldn't surface until a deployment tried to run.
 */
export function validateStrategy(key: string, mod: StrategyModule): void {
  const missing = Object.keys(COMMON_PARAMS).filter((k) => !(k in mod.params));
  if (missing.length > 0) {
    throw new Error(
      `Strategy "${key}" is missing common params: ${missing.join(", ")}. ` +
        `Wrap the strategy's params with withCommonParams(...).`,
    );
  }
}
