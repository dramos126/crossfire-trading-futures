import { describe, expect, it, afterEach } from "vitest";

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkBareRequires } from "./check-runtime-deps.mjs";

/* Fixture provenance: the pair is the real BARE_REQUIRES entry, the range
 * `^4.1.4` is the real `dependencies` pin in package.json, and the lockfile
 * fixture is the key line copied from yarn.lock:4137 — both halves have to be
 * the values yarn actually wrote, because the degraded mode matches
 * `name@range` exactly. */

const PAIR = {
  module: "tough-cookie",
  from: "node_modules/@microsoft/signalr/dist/cjs",
  why: "FetchHttpClient requires it by name but signalr does not declare it",
};

const PKG_JSON = JSON.stringify({
  name: "runtime-deps-fixture",
  dependencies: { "tough-cookie": "^4.1.4" },
  devDependencies: {},
});

const PKG_JSON_WITHOUT = JSON.stringify({
  name: "runtime-deps-fixture",
  dependencies: {},
  devDependencies: {},
});

const YARN_LOCK = ['tough-cookie@^4.0.0, tough-cookie@^4.1.4:', '  version "4.1.4"', ""].join(
  "\n",
);

function deps(overrides: Record<string, unknown>) {
  return {
    dirExists: () => false,
    resolves: () => true,
    directRange: () => "^4.1.4",
    lockHasSpec: () => true,
    ...overrides,
  };
}

describe("checkBareRequires", () => {
  it("probes by resolution when the requirer's directory is on disk", () => {
    const calls: string[] = [];
    const result = checkBareRequires(
      [PAIR],
      deps({
        dirExists: () => true,
        resolves: (module: string) => {
          calls.push(module);
          return true;
        },
        directRange: () => {
          throw new Error("lockfile consulted while the tree was present");
        },
      }),
    );
    expect(calls).toEqual(["tough-cookie"]);
    expect(result.errors).toEqual([]);
    expect(result.degraded).toEqual([]);
  });

  it("reports a resolution failure against a present tree as a hard error", () => {
    const result = checkBareRequires([PAIR], deps({ dirExists: () => true, resolves: () => false }));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].mode).toBe("probe");
    expect(result.errors[0].text).toBe(
      "tough-cookie does not resolve from node_modules/@microsoft/signalr/dist/cjs (tree present)",
    );
  });

  it("falls back to the lockfile guarantee, without touching the filesystem, when the requirer's directory is absent", () => {
    const result = checkBareRequires(
      [PAIR],
      deps({
        resolves: () => {
          throw new Error("resolution probed against an absent tree");
        },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.degraded).toEqual([
      { module: "tough-cookie", from: PAIR.from, range: "^4.1.4" },
    ]);
  });

  it("fails without node_modules when the module is no longer a direct production dependency", () => {
    const result = checkBareRequires([PAIR], deps({ directRange: () => null }));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].mode).toBe("lockfile");
    expect(result.errors[0].text).toBe(
      "tough-cookie is not declared as a direct production dependency (lockfile check)",
    );
    // The tree-present wording must never surface for an absent tree — it
    // sends the reader hunting a hoist bug in a tree that is not there.
    expect(result.errors[0].text).not.toContain("does not resolve");
  });

  it("fails without node_modules when yarn.lock has no entry for the declared range", () => {
    const result = checkBareRequires([PAIR], deps({ lockHasSpec: () => false }));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].mode).toBe("lockfile");
    expect(result.errors[0].text).toBe(
      "tough-cookie@^4.1.4 is a direct production dependency with no yarn.lock entry (lockfile check)",
    );
  });
});

const SCRIPT = fileURLToPath(new URL("./check-runtime-deps.mjs", import.meta.url));
const made: string[] = [];

/** A workspace with only the files the checked-out repo has before install. */
function workspace(files: Record<string, string>, dirs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-deps-"));
  made.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  for (const rel of dirs) mkdirSync(join(dir, rel), { recursive: true });
  return dir;
}

function run(cwd: string) {
  const proc = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
  return { status: proc.status, out: proc.stdout, err: proc.stderr };
}

afterEach(() => {
  while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

describe("check-runtime-deps.mjs", () => {
  it("exits 0 on a fresh workspace and says which mode ran", () => {
    const dir = workspace({ "package.json": PKG_JSON, "yarn.lock": YARN_LOCK });
    const { status, out } = run(dir);
    expect(status).toBe(0);
    expect(out).toContain("lockfile mode (direct dependency ^4.1.4 + yarn.lock entry)");
    expect(out).toContain("the deps-prod probe is the authoritative filesystem check");
    expect(out).toContain("(0 by resolution, 1 by lockfile guarantee)");
  });

  it("exits 1 on a fresh workspace when tough-cookie is dropped from dependencies", () => {
    const dir = workspace({ "package.json": PKG_JSON_WITHOUT, "yarn.lock": YARN_LOCK });
    const { status, err } = run(dir);
    expect(status).toBe(1);
    expect(err).toContain("Bare-require lockfile guarantee FAILED");
    expect(err).toContain(
      "tough-cookie is not declared as a direct production dependency (lockfile check)",
    );
    expect(err).not.toContain("does not resolve");
  });

  it("still resolves for real when the requirer's directory is present", () => {
    const dir = workspace(
      {
        "package.json": PKG_JSON,
        "yarn.lock": YARN_LOCK,
        "node_modules/tough-cookie/package.json": JSON.stringify({
          name: "tough-cookie",
          version: "4.1.4",
          main: "index.js",
        }),
        "node_modules/tough-cookie/index.js": "module.exports = {};\n",
      },
      [PAIR.from],
    );
    const { status, out } = run(dir);
    expect(status).toBe(0);
    expect(out).toContain("(1 by resolution, 0 by lockfile guarantee)");
    expect(out).not.toContain("lockfile mode");
  });

  it("exits 1 when the requirer's directory is present and the module is not", () => {
    const dir = workspace({ "package.json": PKG_JSON, "yarn.lock": YARN_LOCK }, [PAIR.from]);
    const { status, err } = run(dir);
    expect(status).toBe(1);
    expect(err).toContain("Bare-require resolution FAILED");
    expect(err).toContain("does not resolve from node_modules/@microsoft/signalr/dist/cjs (tree present)");
    expect(err).not.toContain("lockfile check");
  });
});
