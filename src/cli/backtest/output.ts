/**
 * Where a run lands and what its header says.
 *
 * One directory per run, JSON for summaries and JSON Lines for anything
 * per-trade or per-session. The default root is `runsRoot()` — the
 * same resolution the web app's *Saved Runs* reader uses, so a run written
 * here is one that reader finds on every machine sharing the mount. Nothing
 * is ever written inside `src/` — the outputs are data, and a stray
 * `--out src/…` would put a few hundred megabytes of them in the tree.
 */
import { existsSync, mkdirSync, promises as fs, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ParamSchema, ParamValues } from "@/lib/trading/strategy-types";
import { offCalibrationKeys } from "@/lib/trading/param-explore";
import { CLASSIFIER_VERSION } from "@/lib/trading/regime/classify-regime";
import type { ContractSpec, SpecTicker } from "@/lib/trading/contracts/contract-specs";
import { ARTIFACTS_DIR_VAR, artifactPathRefusal, researchRoot, runsRoot } from "@/lib/trading/backtest-artifacts";
import { CliError } from "./cli-error";
import type { BarTailRecord, CacheFileRef } from "./bars";
import { runsInSampleWindows, type CliArgs } from "./args";
import type { CpuReport } from "./throttle";

const RUN_ID_LENGTH = 8;

export interface RunHeader {
  gitSha: string | null;
  /** Null for `labels`, which runs no playbook. */
  playbookKey: string | null;
  playbookVersion: string | null;
  /**
   * The instrument the playbook declares it was calibrated for, or null when
   * it declares none (and for `labels`, which runs no playbook).
   *
   * **`ticker !== calibratedFor` is what makes a `--cross-instrument` run
   * readable as one**, off the header rather than off `cliArgs`. A flag a
   * reader has to grep for is a flag they will not find, and the file this
   * distinguishes is a portability read that otherwise looks exactly like a
   * calibration.
   */
  calibratedFor: SpecTicker | null;
  /**
   * `--bar-symbol` when the run substituted one instrument's bars for the
   * ticker's own cache mapping, else null. This is what makes a substituted
   * run distinguishable from a normal one after the fact — a run priced
   * MNQ's economics off NQ bars looks identical to an on-instrument run in
   * every other field, and `ticker` alone cannot tell the two apart because
   * `ticker` never changes.
   */
  barSymbol: string | null;
  /** sha256 over the resolved params, so two runs can be compared without
   *  diffing their flag lists. */
  calibrationHash: string;
  /** The version that produced this run's labels, or **null when no label
   *  was computed** — a version stamped on a run that never classified
   *  anything is a claim the file cannot back. */
  classifierVersion: string | null;
  ticker: string;
  timeframe: string;
  from: string;
  to: string;
  warmupFrom: string;
  barCount: number;
  sessionCount: number;
  firstBarTs: string | null;
  lastBarTs: string | null;
  cacheFiles: CacheFileRef[];
  /** Null on a cache-only run; otherwise the Topstep contract and the range
   *  of 1m bars the tail served past the archive. `cacheFiles` alone would
   *  describe a tailed run as an archive run. */
  barTail: BarTailRecord | null;
  contract: {
    tickSize: number;
    tickValue: number;
    feePerSide: number;
    daySession: { start: string; end: string };
  };
  /** Which of the two questions the run answered. `contracts` is a fixed
   *  count and the R statistics are pure signal quality; `risk` ran the
   *  engine's own sizer per entry, so the dollar figures are account fit and
   *  `skipReasonCounts.risk_budget` is half the result. */
  sizing:
    | { mode: "contracts"; contracts: number }
    | { mode: "risk"; riskUsd: number; maxContracts: number };
  /** The duty cycle asked for and the one the run actually held, so a run
   *  that overshot on a shared machine says so in its own file. */
  cpu: CpuReport;
  /** `walk-forward` only. `inSample: false` is the default no-sweep mode,
   *  where the training windows were never run — so a reader knows the
   *  fold's null `inSample` is a mode and not a missing measurement. */
  walkForward: { inSample: boolean } | null;
  resolvedParams: ParamValues;
  /**
   * The keys of `resolvedParams` whose value is off the playbook's calibration
   * list — empty for a calibrated run. Read off the values rather than off
   * `--explore`, for the reason `calibratedFor` is: a reader who has to grep
   * `cliArgs` for a flag will not, and this is what makes a research run
   * readable as one. Under `walk-forward` it covers the base set only, as
   * `resolvedParams` does.
   */
  offCalibration: string[];
  cliArgs: string[];
  generatedAt: string;
}

export interface BuildHeaderArgs {
  args: CliArgs;
  spec: ContractSpec;
  playbookVersion: string | null;
  /** The playbook's param schema; null for `labels`, which runs no playbook. */
  paramSchema: Record<string, ParamSchema> | null;
  calibratedFor: SpecTicker | null;
  warmupFrom: string;
  barCount: number;
  sessionCount: number;
  firstBarTs: string | null;
  lastBarTs: string | null;
  cacheFiles: CacheFileRef[];
  /** Absent on the commands that never tail. */
  barTail?: BarTailRecord | null;
  resolvedParams: ParamValues;
  cpu: CpuReport;
}

export function buildHeader(input: BuildHeaderArgs): RunHeader {
  const { args, spec } = input;
  return {
    gitSha: currentGitSha(),
    playbookKey: args.playbook,
    playbookVersion: input.playbookVersion,
    calibratedFor: input.calibratedFor,
    barSymbol: args.barSymbol,
    calibrationHash: hashParams(input.resolvedParams),
    classifierVersion: args.usesClassifier ? CLASSIFIER_VERSION : null,
    ticker: args.ticker,
    timeframe: args.timeframe,
    from: args.from,
    to: args.to,
    warmupFrom: input.warmupFrom,
    barCount: input.barCount,
    sessionCount: input.sessionCount,
    firstBarTs: input.firstBarTs,
    lastBarTs: input.lastBarTs,
    cacheFiles: input.cacheFiles,
    barTail: input.barTail ?? null,
    contract: {
      tickSize: spec.tickSize,
      tickValue: spec.tickValue,
      feePerSide: args.fees ? spec.feePerSide : 0,
      daySession: spec.daySession,
    },
    sizing:
      args.riskUsd == null
        ? { mode: "contracts", contracts: args.contracts }
        : { mode: "risk", riskUsd: args.riskUsd, maxContracts: args.maxContracts },
    cpu: input.cpu,
    walkForward:
      args.command === "walk-forward" ? { inSample: runsInSampleWindows(args) } : null,
    resolvedParams: input.resolvedParams,
    offCalibration:
      input.paramSchema == null ? [] : offCalibrationKeys(input.paramSchema, input.resolvedParams),
    cliArgs: [args.command, ...args.raw],
    generatedAt: new Date().toISOString(),
  };
}

/** Sorted keys so the hash tracks the values, not the flag order. */
export function hashParams(params: ParamValues): string {
  const sorted = Object.fromEntries(
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export function currentGitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Whether tracked files differ from `HEAD`, so a sha is not read as the code
 *  that ran when it was not. Null when git cannot say. */
export function currentGitDirty(): boolean | null {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * Resolve the run directory and create it.
 *
 * Created here, and every command calls this before it reads a bar: the
 * default root is a subdirectory of a network mount that may be absent or
 * unwritable on the box running the command, and finding that out at the
 * write step is finding it out after minutes of a walk-forward. The refusal
 * names the root and the variable that moves it.
 */
export function resolveOutDir(args: CliArgs): string {
  const suffix = `${args.ticker}-${args.timeframe}-${args.from}-${args.to}-${newRunId()}`;
  // `labels` has no playbook; its runs land under research/, named for the command.
  const parent = args.playbook != null ? path.join(runsRoot(), args.playbook) : path.join(researchRoot(), args.command);
  return makeRunDir(args.out ?? path.join(parent, suffix));
}

export function newRunId(): string {
  return randomUUID().replace(/-/g, "").slice(0, RUN_ID_LENGTH);
}

/** Create `out` (never inside `src/`, never outside the artifact root's four
 *  folders), refusing an unwritable root by name. */
export function makeRunDir(out: string): string {
  const dir = path.resolve(out);
  const srcDir = path.join(repoRoot(), "src");
  if (dir === srcDir || dir.startsWith(srcDir + path.sep)) {
    throw new CliError(`--out may not write inside src/: ${dir}`);
  }
  const refusal = artifactPathRefusal(dir);
  if (refusal != null) throw new CliError(`--out refused: ${refusal}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "unknown";
    throw new CliError(
      `cannot create the run directory ${dir} (${code}). ` +
        `The root resolves from ${ARTIFACTS_DIR_VAR}, else $BAR_CACHE_DIR/backtests, else ./backtests — ` +
        `on the shared mount ${ARTIFACTS_DIR_VAR} must be set explicitly, because artifacts are a sibling ` +
        `of the cache there and not a subdirectory of it; ` +
        `pass --out or set ${ARTIFACTS_DIR_VAR} to write elsewhere.`,
    );
  }
  return dir;
}

/**
 * The repo root, walked up from this file to the directory holding
 * `package.json`.
 *
 * Resolving `src/` against the cwd instead would make the guard depend on
 * where the command was typed: run from `src/lib/`, `path.resolve("src")` is
 * `src/lib/src`, which exists nowhere, and a `--out ../..` lands hundreds of
 * megabytes of run directories in the tree unopposed.
 */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new CliError(`No package.json above ${import.meta.url} — cannot locate the repo root`);
    }
    dir = parent;
  }
}

export async function writeJson(dir: string, name: string, value: unknown): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

/** Through a temp file and a rename, so a reader never sees half a file. */
export function writeFileAtomically(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, file);
}

export async function writeJsonl(
  dir: string,
  name: string,
  rows: readonly unknown[],
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
  return file;
}
