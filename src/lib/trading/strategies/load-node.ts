/**
 * The strategy registry, loaded under plain Node.
 *
 * `index.ts` builds the same table with webpack's `require.context`, which
 * exists only inside a bundler — under `tsx` it is not a function. This is
 * the loader for anything running outside Next: today the backtest CLI, and
 * nothing in the app imports it. The two loaders share
 * `registry-core.ts` so a module that passes one passes the other; the key
 * derivation (**filename**, not directory) is deliberately duplicated as a
 * regex because it is two lines and a shared helper would be a seam between
 * a bundler mechanism and a filesystem walk.
 *
 * It loads every module — `prod/`, `staging/`, `wip/`, `retired/` and `test/` — and
 * ignores which builds a folder reaches on purpose: that is about what a Next
 * build can trade, and the CLI is a research tool that places no orders and
 * never ships in the runtime image.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { StrategyModule } from "../strategy-types";
import { applyConfigDefaults, validateStrategy } from "./registry-core";

const STRATEGY_SUFFIX = ".strategy.ts";
const TEST_SUBTREE = "test";

export interface LoadStrategiesNodeOptions {
  /** Include modules under `test/`, stamped `isTest`. The CLI passes true —
   *  the test fixtures are candidates for the measured re-evaluation pass. */
  includeTest: boolean;
  /** Root to walk. Defaults to this file's own directory. */
  dir?: string;
}

export async function loadStrategiesNode(
  opts: LoadStrategiesNodeOptions,
): Promise<Record<string, StrategyModule>> {
  const root = opts.dir ?? path.dirname(fileURLToPath(import.meta.url));
  const files = await walk(root);

  const strategies: Record<string, StrategyModule> = {};
  for (const file of files.sort()) {
    const key = path.basename(file).slice(0, -STRATEGY_SUFFIX.length);
    const isTest = path.relative(root, file).split(path.sep)[0] === TEST_SUBTREE;
    if (isTest && !opts.includeTest) continue;

    const imported = (await import(pathToFileURL(file).href)) as {
      default?: StrategyModule;
    };
    const mod = imported.default;
    // A `*.strategy.ts` with no default export reaches `validateStrategy` as
    // `undefined` and fails on a property read, naming neither the file nor
    // the omission.
    if (mod == null) {
      throw new Error(`${file} exports no default strategy module`);
    }
    validateStrategy(key, mod);
    strategies[key] = {
      ...mod,
      key,
      ...(isTest ? { isTest: true } : {}),
      params: applyConfigDefaults(mod),
    };
  }
  return strategies;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.name.endsWith(STRATEGY_SUFFIX)) {
      out.push(full);
    }
  }
  return out;
}
