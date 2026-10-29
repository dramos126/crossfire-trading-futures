/**
 * `require.context` under plain Node, for the one CLI path that needs it.
 *
 * The Topstep tail has to reach bars through `topstepMarketDataProvider`
 * (providers.md: nothing else calls `retrieveBars`), and that provider's
 * import graph — the broker registry, the Topstep plugin, `db/deployments` —
 * reaches `strategies/index.ts`, whose registry is built with webpack's
 * `require.context`. Under `tsx` that is not a function and the import throws
 * before a bar is read.
 *
 * Rather than stub the registry, this runs the real `index.ts` with a
 * filesystem-backed `require.context` injected into the module's own scope,
 * so its allowlist regex and staging gate execute exactly as written. The
 * CLI's playbooks still come from `loadStrategiesNode`; this only lets the
 * provider's graph load. Installed only when a command asks for the tail, so
 * a cache-only run never patches the module loader.
 */
import { readdirSync } from "node:fs";
import Module from "node:module";
import path from "node:path";

import type { StrategyContext } from "@/lib/trading/strategies/registry-core";

const CONTEXT_CALL = "require.context(";
const GLOBAL_KEY = "__crossfireRequireContext";

type Compile = (this: Module, content: string, filename: string) => unknown;
type ContextFactory = (
  fromFile: string,
  req: (id: string) => unknown,
  dir: string,
  deep: boolean,
  filter: RegExp,
) => StrategyContext;

let installed = false;

export function installNodeRequireContext(): void {
  if (installed) return;
  installed = true;

  const factory: ContextFactory = (fromFile, req, dir, deep, filter) => {
    const root = path.resolve(path.dirname(fromFile), dir);
    const keys = listRelative(root, deep).filter((key) => filter.test(key));
    return Object.assign(
      (id: string) => req(path.join(root, id)) as { default: never },
      { keys: () => keys },
    );
  };
  Object.assign(globalThis, { [GLOBAL_KEY]: factory });

  const proto = Module.prototype as unknown as { _compile: Compile };
  const original = proto._compile;
  proto._compile = function patched(this: Module, content: string, filename: string) {
    if (!content.includes(CONTEXT_CALL)) return original.call(this, content, filename);
    // Prepended inside the CommonJS wrapper, where `require` and `__filename`
    // are this module's own — the only scope `require.context` is read from.
    const prelude =
      `require.context = (d, deep, re) => globalThis.${GLOBAL_KEY}(__filename, require, d, deep, re);`;
    return original.call(this, `${prelude}${content}`, filename);
  };
}

/** `./`-relative, `/`-separated paths, the form webpack hands a context's
 *  regex — the allowlist regex in `index.ts` is written against it. */
export function listRelative(root: string, deep: boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (deep) walk(full);
      } else {
        out.push(`./${path.relative(root, full).split(path.sep).join("/")}`);
      }
    }
  };
  walk(root);
  return out.sort();
}
