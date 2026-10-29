import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { ARTIFACTS_DIR_VAR } from "@/lib/trading/backtest-artifacts";
import { parseArgs } from "./args";
import { buildHeader, makeRunDir } from "./output";
import { CliError } from "./cli-error";
import type { BarTailRecord } from "./bars";
import type { ParamSchema, ParamValues } from "@/lib/trading/strategy-types";

const MINIMAL = [
  "--ticker",
  "MNQ",
  "--timeframe",
  "5m",
  "--from",
  "2025-06-02",
  "--to",
  "2025-06-30",
  "--playbook",
  "orb",
];

const SPEC = CONTRACT_SPECS.MNQ;

const CUTOFF: Record<string, ParamSchema> = {
  entryEndEt: {
    type: "select",
    label: "Last break (ET)",
    default: "10:30",
    options: [
      { value: "10:30", label: "10:30 ET" },
      { value: "11:00", label: "11:00 ET" },
    ],
    explore: { type: "time" },
  },
};

function headerFor(
  argv: string[],
  run: {
    paramSchema?: Record<string, ParamSchema> | null;
    resolvedParams?: ParamValues;
    barTail?: BarTailRecord | null;
  } = {},
) {
  const args = parseArgs("run", argv);
  return buildHeader({
    args,
    spec: SPEC,
    playbookVersion: "1",
    paramSchema: run.paramSchema ?? null,
    calibratedFor: "MNQ",
    warmupFrom: "2025-05-01",
    barCount: 100,
    sessionCount: 10,
    firstBarTs: null,
    lastBarTs: null,
    cacheFiles: [],
    barTail: run.barTail,
    resolvedParams: run.resolvedParams ?? {},
    cpu: { targetPct: 40, workers: 1, achievedPct: 40 },
  });
}

describe("buildHeader", () => {
  it("records the Topstep tail and the range it served, and null on a cache-only run", () => {
    const barTail: BarTailRecord = {
      source: "topstep",
      contractId: "CON.F.US.MNQ.Z26",
      cacheMaxUtc: "2026-10-10T20:59:00.000Z",
      fromUtc: "2026-10-11T22:00:00.000Z",
      toUtc: "2026-10-12T20:59:00.000Z",
      barCount: 1380,
      seam: { cacheMonth: "Z2026", tailMonth: "Z2026", gapTicks: 1 },
    };
    expect(headerFor([...MINIMAL, "--topstep-tail"], { barTail }).barTail).toEqual(barTail);
    expect(headerFor(MINIMAL).barTail).toBeNull();
  });

  it("records barSymbol as null when --bar-symbol was not given", () => {
    expect(headerFor(MINIMAL).barSymbol).toBeNull();
  });

  it("records barSymbol when --bar-symbol substituted the cache symbol", () => {
    const header = headerFor([...MINIMAL, "--bar-symbol", "NQ.c.0"]);
    expect(header.barSymbol).toBe("NQ.c.0");
    // The substitution is bars-only: the contract economics on the header
    // still come from --ticker, not from the substituted symbol.
    expect(header.ticker).toBe("MNQ");
    expect(header.contract.tickValue).toBe(SPEC.tickValue);
  });

  // Read off the values, not the flag: a research run is identifiable from the
  // header alone, and `--explore` on a calibrated run claims nothing.
  it("records the settings off the calibration list, and none on a calibrated run", () => {
    const off = headerFor([...MINIMAL, "--explore"], {
      paramSchema: CUTOFF,
      resolvedParams: { entryEndEt: "12:15" },
    });
    expect(off.offCalibration).toEqual(["entryEndEt"]);
    const on = headerFor([...MINIMAL, "--explore"], {
      paramSchema: CUTOFF,
      resolvedParams: { entryEndEt: "11:00" },
    });
    expect(on.offCalibration).toEqual([]);
    expect(headerFor(MINIMAL).offCalibration).toEqual([]);
  });

  // No flag is needed to set one, and the header names it all the same.
  it("records a calibrated number outside its range, and not its off value", () => {
    const schema: Record<string, ParamSchema> = {
      maxStopTicks: {
        type: "integer",
        label: "Widest stop taken (ticks)",
        default: 450,
        min: 0,
        max: 800,
        calibrated: { kind: "rangeOrOff", min: 300, max: 800 },
      },
    };
    const at = (maxStopTicks: number) =>
      headerFor(MINIMAL, { paramSchema: schema, resolvedParams: { maxStopTicks } }).offCalibration;
    expect(at(150)).toEqual(["maxStopTicks"]);
    expect(at(900)).toEqual(["maxStopTicks"]);
    expect(at(0)).toEqual([]);
    expect(at(450)).toEqual([]);
  });
});

describe("makeRunDir", () => {
  let root: string | null = null;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("refuses an --out that would make a folder at the artifact root, and creates nothing", () => {
    root = mkdtempSync(path.join(tmpdir(), "artifacts-"));
    vi.stubEnv(ARTIFACTS_DIR_VAR, root);
    expect(() => makeRunDir(path.join(root!, "orb-exits", "x-ctrl"))).toThrow(CliError);
    expect(existsSync(path.join(root, "orb-exits"))).toBe(false);
  });

  it("creates a run under its playbook", () => {
    root = mkdtempSync(path.join(tmpdir(), "artifacts-"));
    vi.stubEnv(ARTIFACTS_DIR_VAR, root);
    const dir = makeRunDir(path.join(root, "runs", "orb", "size-350"));
    expect(existsSync(dir)).toBe(true);
  });
});
