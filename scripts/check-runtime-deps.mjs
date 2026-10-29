#!/usr/bin/env node
// Catch the class of break where a dev dependency changes what gets hoisted
// to the root of node_modules, and the *production* image — which is a
// different tree — ends up without a module something reaches by bare name.
//
// The shape, from 2026-08-26: adding jsdom (dev) pulled tough-cookie@5 to the
// root and pushed the v4 that @microsoft/signalr needs down under
// fetch-cookie. signalr does a bare `require("tough-cookie")`, which Node
// resolves upward to the root only. The dev tree was fine, every build was
// green, and both SignalR hubs died at boot on staging.
//
// Two checks, deliberately different in kind:
//
//   1. MULTI-MAJOR SPLIT — static, lockfile only. If one package resolves to
//      two majors and the two closures (prod vs dev) disagree about which,
//      dropping dev deps *will* change the root hoist. That is a warning
//      rather than an error: it is a strong smell, not proof of breakage.
//   2. BARE-REQUIRE MANIFEST — a hard list of (module, requiring package)
//      pairs that must resolve from the requirer's own directory. This is an
//      error. Add a pair whenever you find a package that requires something
//      it does not declare.
//
// Check 2 runs in one of two modes, because the CI stage sits in the
// parallel block beside `Test` and deliberately installs nothing:
//
//   PROBE    — the requirer's directory is on disk, so resolve for real. A
//              failure there is a broken tree and a hard error.
//   LOCKFILE — the directory is absent (fresh workspace, first build of a
//              branch). Fall back to the guarantee the lockfile can prove:
//              the module is a direct entry in package.json `dependencies`
//              — which is what puts it at the root of the production hoist,
//              and is literally the tough-cookie fix — and yarn.lock has the
//              matching spec. Both present: name the mode and exit 0. Direct
//              dependency gone: hard error without node_modules, because the
//              lockfile alone proves the regression.
//
// Degrading is safe because this is not the last line of defence: the
// Dockerfile's deps-prod stage re-runs the resolution probe against the tree
// that actually ships, after a real `yarn install --production`. That is the
// authoritative filesystem check; this script is the fast pre-flight. Keep
// both, and keep their bare-require lists in step.
//
// Before 2026-08-26 the probe ran unconditionally and passed only because the
// CI workspace happened to retain node_modules from an earlier build.
// The `dev` branch's first build got a fresh workspace and the stage failed
// with "does not resolve" against a tree that was merely absent.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Modules reached by bare `require()` from inside another package, which
 *  therefore must be resolvable from that package's directory. */
export const BARE_REQUIRES = [
  {
    module: "tough-cookie",
    from: "node_modules/@microsoft/signalr/dist/cjs",
    why: "FetchHttpClient requires it by name but signalr does not declare it; it rides on fetch-cookie's hoist",
  },
];

// ── yarn.lock (v1) → { "name@range": { version, deps: [name@range] } } ──
export function parseLock(text) {
  const entries = new Map();
  let keys = null;
  let cur = null;
  let inDeps = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0 && raw.trimEnd().endsWith(":")) {
      if (keys && cur) for (const k of keys) entries.set(k, cur);
      keys = raw
        .trimEnd()
        .slice(0, -1)
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""));
      cur = { version: null, deps: [] };
      inDeps = false;
      continue;
    }
    if (!cur) continue;
    const line = raw.trim();
    if (indent === 2) {
      inDeps = /^(dependencies|optionalDependencies):$/.test(line);
      const v = line.match(/^version\s+"?([^"]+)"?$/);
      if (v) cur.version = v[1];
      continue;
    }
    if (indent >= 4 && inDeps) {
      const m = line.match(/^"?([^"\s]+)"?\s+"?([^"]+)"?$/);
      if (m) cur.deps.push(`${m[1]}@${m[2]}`);
    }
  }
  if (keys && cur) for (const k of keys) entries.set(k, cur);
  return entries;
}

/** Walk a set of root specs to every (name → majors) reachable from them. */
export function closure(lock, names) {
  const seen = new Set();
  const byName = new Map();
  const queue = names.flatMap((n) =>
    [...lock.keys()].filter((k) => k.slice(0, k.lastIndexOf("@")) === n),
  );
  while (queue.length) {
    const spec = queue.shift();
    if (seen.has(spec)) continue;
    seen.add(spec);
    const e = lock.get(spec);
    if (!e?.version) continue;
    const name = spec.slice(0, spec.lastIndexOf("@"));
    const major = e.version.split(".")[0];
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(major);
    for (const d of e.deps) if (lock.has(d)) queue.push(d);
  }
  return byName;
}

export function hoistWarnings(prod, dev) {
  const warnings = [];
  for (const [name, prodMajors] of prod) {
    const devMajors = dev.get(name);
    if (!devMajors) continue;
    const union = new Set([...prodMajors, ...devMajors]);
    if (union.size < 2) continue;
    const devOnly = [...devMajors].filter((m) => !prodMajors.has(m));
    if (devOnly.length === 0) continue;
    warnings.push(
      `${name}: production needs ${[...prodMajors].sort().join("/")}, ` +
        `dev-only brings ${devOnly.sort().join("/")} — the root hoist differs between the two trees`,
    );
  }
  return warnings;
}

/**
 * Probe where the requirer's tree is on disk; fall back to what the lockfile
 * can prove where it is not. The two failure texts are deliberately distinct:
 * "does not resolve" is a claim about a tree that exists, and printing it for
 * an absent one sends the reader hunting a hoist bug that is not there.
 *
 * @param pairs  typeof BARE_REQUIRES
 * @param deps   { dirExists(from), resolves(module, from),
 *                 directRange(module), lockHasSpec(spec) }
 */
export function checkBareRequires(pairs, deps) {
  const errors = [];
  const degraded = [];
  for (const { module, from, why } of pairs) {
    if (deps.dirExists(from)) {
      if (!deps.resolves(module, from)) {
        errors.push({
          mode: "probe",
          module,
          why,
          text: `${module} does not resolve from ${from} (tree present)`,
        });
      }
      continue;
    }
    const range = deps.directRange(module);
    if (!range) {
      errors.push({
        mode: "lockfile",
        module,
        why,
        text: `${module} is not declared as a direct production dependency (lockfile check)`,
      });
      continue;
    }
    if (!deps.lockHasSpec(`${module}@${range}`)) {
      errors.push({
        mode: "lockfile",
        module,
        why,
        text: `${module}@${range} is a direct production dependency with no yarn.lock entry (lockfile check)`,
      });
      continue;
    }
    degraded.push({ module, from, range });
  }
  return { errors, degraded };
}

function main() {
  const root = process.cwd();
  const require_ = createRequire(path.join(root, "noop.js"));

  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = parseLock(readFileSync(path.join(root, "yarn.lock"), "utf8"));

  const warnings = hoistWarnings(
    closure(lock, Object.keys(pkg.dependencies ?? {})),
    closure(lock, Object.keys(pkg.devDependencies ?? {})),
  );

  const { errors, degraded } = checkBareRequires(BARE_REQUIRES, {
    dirExists: (from) => existsSync(path.join(root, from)),
    resolves: (module, from) => {
      try {
        require_.resolve(module, { paths: [path.join(root, from)] });
        return true;
      } catch {
        return false;
      }
    },
    directRange: (module) => pkg.dependencies?.[module] ?? null,
    lockHasSpec: (spec) => lock.has(spec),
  });

  if (warnings.length) {
    console.warn("\n  Dependency hoist warnings (not fatal):\n");
    for (const w of warnings) console.warn(`    ! ${w}`);
    console.warn(
      "\n    Not an error on its own — many packages legitimately appear at two majors.\n" +
        "    It matters when something reaches one of them by bare require(). If that\n" +
        "    is the case here, add the pair to BARE_REQUIRES in this file.\n",
    );
  }

  for (const { module, from, range } of degraded) {
    console.log(
      `  ~ ${module}: ${from} is absent — lockfile mode (direct dependency ${range} ` +
        `+ yarn.lock entry), the deps-prod probe is the authoritative filesystem check`,
    );
  }

  const probeErrors = errors.filter((e) => e.mode === "probe");
  const lockErrors = errors.filter((e) => e.mode === "lockfile");

  if (probeErrors.length) {
    console.error("\n  Bare-require resolution FAILED:\n");
    for (const e of probeErrors) console.error(`    x ${e.text}\n      ${e.why}`);
    console.error(
      "\n  This tree cannot serve a module something requires by name. The production\n" +
        "  image drops dev dependencies and re-hoists, so it may be worse there, not\n" +
        "  better — see the deps-prod stage in the Dockerfile.\n",
    );
  }

  if (lockErrors.length) {
    console.error("\n  Bare-require lockfile guarantee FAILED:\n");
    for (const e of lockErrors) console.error(`    x ${e.text}\n      ${e.why}`);
    console.error(
      "\n  node_modules is absent here, so this ran against package.json + yarn.lock\n" +
        "  alone — and that is enough. A module reached by bare require() from a package\n" +
        "  that does not declare it only sits at the root of the production tree because\n" +
        "  *we* depend on it directly, so dropping it from `dependencies` loses it in the\n" +
        "  shipped image however healthy the dev tree looks. Put it back.\n",
    );
  }

  if (errors.length) return 1;

  const verified =
    `${BARE_REQUIRES.length} bare-require pair(s) verified ` +
    `(${BARE_REQUIRES.length - degraded.length} by resolution, ` +
    `${degraded.length} by lockfile guarantee)`;
  console.log(`runtime deps OK — ${verified}, ${warnings.length} hoist warning(s)`);
  return 0;
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsScript) process.exit(main());
