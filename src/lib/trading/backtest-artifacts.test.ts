import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join, resolve, sep } from "node:path";

// An in-memory tree keyed by absolute path. Directories are implied by the
// files beneath them; `failures` makes a directory throw a named code on
// readdir, which is how a present-but-unreadable root is stated.
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failures: new Map<string, string>(),
}));

vi.mock("node:fs/promises", async () => {
  const { sep: s, join: j } = await import("node:path");
  const fail = (code: string, path: string) =>
    Object.assign(new Error(`${code}: ${path}`), { code });
  const isDir = (p: string): boolean => {
    for (const key of fsState.files.keys()) if (key.startsWith(p + s)) return true;
    return false;
  };
  return {
    readdir: vi.fn(async (dir: string) => {
      const failure = fsState.failures.get(dir);
      if (failure != null) throw fail(failure, dir);
      if (!isDir(dir)) throw fail("ENOENT", dir);
      const names = new Set<string>();
      for (const key of fsState.files.keys()) {
        if (!key.startsWith(dir + s)) continue;
        names.add(key.slice(dir.length + 1).split(s)[0]);
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => isDir(j(dir, name)),
      }));
    }),
    readFile: vi.fn(async (path: string) => {
      const content = fsState.files.get(path);
      if (content == null) throw fail("ENOENT", path);
      return content;
    }),
    stat: vi.fn(async (path: string) => {
      if (!fsState.files.has(path)) throw fail("ENOENT", path);
      return { mtimeMs: 1_000 };
    }),
  };
});

import { readFile } from "node:fs/promises";
import {
  ARTIFACTS_DIR_VAR,
  artifactPathRefusal,
  artifactRoot,
  listRuns,
  readRun,
  resolveRunDir,
} from "./backtest-artifacts";

const MOUNT = resolve(sep, "mnt", "cache");
const MOUNT_ROOT = join(MOUNT, "backtests");

const HEADER = JSON.stringify({
  header: {
    playbookKey: "orb",
    ticker: "MNQ",
    timeframe: "5m",
    from: "2025-01-02",
    to: "2025-06-30",
    calibratedFor: "MNQ",
    contract: { tickSize: 0.25 },
  },
});

function seedRun(root: string, rel: string, withTrades = true): void {
  fsState.files.set(join(root, rel, "run.json"), HEADER);
  if (withTrades) {
    fsState.files.set(join(root, rel, "trades.jsonl"), '{"tradeId":1}\n{"tradeId":2}\n');
  }
}

beforeEach(() => {
  fsState.files.clear();
  fsState.failures.clear();
  vi.mocked(readFile).mockClear();
  // The production resolver treats empty as unset, so stubbing to "" is how
  // a variable is taken out of play without touching the real environment.
  vi.stubEnv(ARTIFACTS_DIR_VAR, "");
  vi.stubEnv("BAR_CACHE_DIR", MOUNT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("artifactRoot", () => {
  it("prefers BACKTEST_ARTIFACTS_DIR over the bar cache", () => {
    const explicit = resolve(sep, "srv", "runs");
    vi.stubEnv(ARTIFACTS_DIR_VAR, explicit);
    expect(artifactRoot()).toBe(explicit);
  });

  it("is the backtests subdirectory of BAR_CACHE_DIR, never the cache root", () => {
    expect(artifactRoot()).toBe(MOUNT_ROOT);
    expect(artifactRoot()).not.toBe(MOUNT);
  });

  it("falls back to the repo-relative backtests/ when neither variable is set", () => {
    vi.stubEnv("BAR_CACHE_DIR", "");
    expect(artifactRoot()).toBe(join(process.cwd(), "backtests"));
  });
});

describe("resolveRunDir", () => {
  it("resolves a run path inside the mount root", () => {
    const dir = resolveRunDir("orb/MNQ-5m-2025-01-02-2025-06-30-abcd1234");
    expect(dir).toBe(join(MOUNT_ROOT, "orb", "MNQ-5m-2025-01-02-2025-06-30-abcd1234"));
    expect(dir?.startsWith(MOUNT_ROOT + sep)).toBe(true);
  });

  it("refuses an escape from backtests/ into the Parquet archive beside it", () => {
    // One `..` from the artifact root is the cache itself — the neighbour
    // the old repo-relative root never had.
    expect(resolve(MOUNT_ROOT, "../ohlcv-1m")).toBe(join(MOUNT, "ohlcv-1m"));
    expect(resolveRunDir("../ohlcv-1m/MNQ.c.0/2025.parquet")).toBeNull();
  });

  it("refuses a sibling that shares the root's prefix", () => {
    expect(resolveRunDir("../backtests-secret/orb/run")).toBeNull();
  });

  it("refuses an absolute path", () => {
    expect(resolveRunDir(resolve(sep, "etc", "passwd"))).toBeNull();
  });

  it("guards whatever root BACKTEST_ARTIFACTS_DIR moved it to", () => {
    const explicit = resolve(sep, "srv", "runs");
    vi.stubEnv(ARTIFACTS_DIR_VAR, explicit);
    expect(resolveRunDir("orb/run")).toBe(join(explicit, "orb", "run"));
    expect(resolveRunDir("../secrets")).toBeNull();
    expect(resolveRunDir("../../mnt/cache/backtests/orb/run")).toBeNull();
  });
});

describe("artifactPathRefusal", () => {
  const at = (...parts: string[]) => join(MOUNT_ROOT, ...parts);

  it("allows a run under its playbook and anything under the other three folders", () => {
    expect(artifactPathRefusal(at("runs", "orb-confluence-capped", "size-350"))).toBeNull();
    expect(artifactPathRefusal(at("research", "orb-exits", "x-ctrl"))).toBeNull();
    expect(artifactPathRefusal(at("parity", "2026-10-22"))).toBeNull();
    expect(artifactPathRefusal(at("scout", "weeks", "2026-10-25"))).toBeNull();
  });

  it("refuses a folder at the root and names where a study goes", () => {
    expect(artifactPathRefusal(at("orb-exits", "x-ctrl"))).toMatch(/"orb-exits" at the artifact root.*research\/<study>\//);
  });

  it("refuses screen-kept, which the root no longer holds", () => {
    expect(artifactPathRefusal(at("screen-kept", "2026-10-17"))).not.toBeNull();
  });

  it("refuses the root itself and a bare folder under runs/", () => {
    expect(artifactPathRefusal(MOUNT_ROOT)).toMatch(/artifact root itself/);
    expect(artifactPathRefusal(at("runs", "orb-exits"))).toMatch(/runs\/<playbook>\/<run>/);
  });

  it("leaves a path outside the root alone — it is never published", () => {
    expect(artifactPathRefusal(resolve(sep, "tmp", "scratch-run"))).toBeNull();
    expect(artifactPathRefusal(join(MOUNT, "backtests-old", "x"))).toBeNull();
  });
});

describe("listRuns", () => {
  it("is empty when the root does not exist", async () => {
    await expect(listRuns()).resolves.toEqual([]);
  });

  it("is empty when the root is present but unreadable", async () => {
    fsState.files.set(join(MOUNT_ROOT, "orb", "run", "run.json"), HEADER);
    fsState.failures.set(MOUNT_ROOT, "EACCES");
    await expect(listRuns()).resolves.toEqual([]);
  });

  it("reaches a sweep grouped one level below runs/<playbook>/, and no deeper", async () => {
    seedRun(MOUNT_ROOT, join("runs", "orb", "sweep", "cell-a"));
    seedRun(MOUNT_ROOT, join("runs", "orb", "sweep", "nest", "cell-b"));
    const runs = await listRuns();
    expect(runs.map((r) => r.runPath)).toEqual(["runs/orb/sweep/cell-a"]);
  });

  it("lists runs by path relative to the mount root and skips a header with no trades", async () => {
    seedRun(MOUNT_ROOT, join("orb", "run-a"));
    seedRun(MOUNT_ROOT, join("tf-arm", "control-5m"), false);
    const runs = await listRuns();
    expect(runs.map((r) => r.runPath)).toEqual(["orb/run-a"]);
    expect(runs[0]).toMatchObject({
      label: "run-a",
      playbookKey: "orb",
      ticker: "MNQ",
      kind: "run",
      tradeCount: 2,
      tickSize: 0.25,
    });
  });

  it("carries the header's resolved params, sizing and fee — what Try settings loads", async () => {
    const header = {
      playbookKey: "orb",
      ticker: "MNQ",
      timeframe: "5m",
      from: "2025-01-02",
      to: "2025-06-30",
      contract: { tickSize: 0.25, feePerSide: 0 },
      sizing: { mode: "risk", riskUsd: 225, maxContracts: 100 },
      resolvedParams: { atrPeriod: 21, timeframe: "5m" },
    };
    fsState.files.set(join(MOUNT_ROOT, "orb", "r", "run.json"), JSON.stringify({ header }));
    fsState.files.set(join(MOUNT_ROOT, "orb", "r", "trades.jsonl"), '{"tradeId":1}\n');
    const [run] = await listRuns();
    expect(run.resolvedParams).toEqual({ atrPeriod: 21, timeframe: "5m" });
    expect(run.sizing).toEqual({ mode: "risk", riskUsd: 225, maxContracts: 100 });
    expect(run.feePerSide).toBe(0);
  });

  it("keeps only the param values a playbook can hold, dropping an object or a stray array", async () => {
    const header = {
      ...JSON.parse(HEADER).header,
      resolvedParams: {
        atrPeriod: 21,
        timeframe: "5m",
        trailOn: false,
        pauseWindows: [{ start: "11:30", end: "13:00" }],
        nested: { start: "09:30" },
        levels: [1, 2, 3],
        windowsMalformed: [{ start: "11:30" }],
        nothing: null,
      },
    };
    fsState.files.set(join(MOUNT_ROOT, "orb", "r", "run.json"), JSON.stringify({ header }));
    fsState.files.set(join(MOUNT_ROOT, "orb", "r", "trades.jsonl"), '{"tradeId":1}\n');
    const [run] = await listRuns();
    expect(run.resolvedParams).toEqual({
      atrPeriod: 21,
      timeframe: "5m",
      trailOn: false,
      pauseWindows: [{ start: "11:30", end: "13:00" }],
    });
  });

  it("reads a header predating those fields, or carrying a sizing it cannot read, as null", async () => {
    seedRun(MOUNT_ROOT, join("orb", "old"));
    const odd = { ...JSON.parse(HEADER).header, sizing: { mode: "contracts", contracts: "two" } };
    fsState.files.set(join(MOUNT_ROOT, "orb", "odd", "run.json"), JSON.stringify({ header: odd }));
    fsState.files.set(join(MOUNT_ROOT, "orb", "odd", "trades.jsonl"), '{"tradeId":1}\n');
    const runs = await listRuns();
    for (const run of runs) {
      expect(run).toMatchObject({ resolvedParams: null, sizing: null, feePerSide: null });
    }
    expect(runs).toHaveLength(2);
  });
});

describe("readRun", () => {
  it("reads a run's trades from under the mount root", async () => {
    seedRun(MOUNT_ROOT, join("orb", "run-a"));
    const run = await readRun("orb/run-a");
    expect(run?.trades).toHaveLength(2);
    expect(run?.summary.runPath).toBe("orb/run-a");
  });

  it("answers null for an escaping path without opening anything", async () => {
    fsState.files.set(join(MOUNT, "ohlcv-1m", "x", "run.json"), HEADER);
    fsState.files.set(join(MOUNT, "ohlcv-1m", "x", "trades.jsonl"), "{}\n");
    await expect(readRun("../ohlcv-1m/x")).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });
});
