/**
 * Reading the CLI's run artifacts back off disk.
 *
 * `corepack yarn backtest` writes `<root>/runs/<playbook>/<run>/` with a
 * `run.json` or a `folds.json` and a `trades.jsonl` beside it, where
 * `<root>` is `artifactRoot()` below — the one resolution both the writer
 * and this reader share. The root's other folders are `parity/`,
 * `research/` and `scout/` (`ARTIFACT_TOP_DIRS`); the reader walks all of them,
 * so a run that lives outside `runs/` still lists. Nothing in `src/` could see any of it until now,
 * which is why twenty-six theses were measured and rejected on aggregate
 * statistics alone — the trades existed, in files the web app had never
 * been taught to open.
 *
 * **A run is identified by its header, never by its directory name.** The
 * default `--out` is `<ticker>-<tf>-<from>-<to>-<runId>`, but `--out`
 * overrides it and the trader uses that: `backtests/tf-arm/control-5m`
 * carries `playbookKey: "opening-range-breakout-v2"`, and `backtests/orb/`
 * and `backtests/ema-bounce/risk1200-5m` are the same shape. Parsing a name
 * would mis-file every hand-named run and silently attribute one playbook's
 * trades to another. The name survives only as the run's display label.
 *
 * Reads are the *only* operation here. Nothing in this module writes, and
 * the CLI is the sole writer of everything it reads — a trader agent holds
 * that process.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";
import type { RunHeader } from "@/cli/backtest/output";
import type { ParamValues, PauseWindow } from "@/lib/trading/strategy-types";

/** The subdirectory the artifacts sit in — beside the bar cache's
 *  `ohlcv-1m/` when the root is the mount, under the repo when it is not. */
const ARTIFACTS_SUBDIR = "backtests";

/** The explicit override. Named here so the CLI's refusal and the infra doc
 *  can point at the same string. */
export const ARTIFACTS_DIR_VAR = "BACKTEST_ARTIFACTS_DIR";

/**
 * Where the CLI writes and this module reads — one rule, in priority order:
 *
 * 1. `BACKTEST_ARTIFACTS_DIR`, when set — **the branch every machine on the
 *    shared mount takes.** Since 2026-09-10 the shared storage keeps the
 *    artifacts as a *sibling* of the cache (`<mount>/backtesting` beside the
 *    cache folder) rather than a subdirectory of it, so branch 2 no
 *    longer describes the mount and this is set explicitly on every
 *    development machine, in the Dockerfile and everywhere else the mount is
 *    used.
 * 2. `$BAR_CACHE_DIR/backtests` — a cache root that *does* nest its
 *    artifacts. This described the mount before the overhaul and no longer
 *    does; it is kept for that layout, not as the mount's answer. Setting
 *    only `BAR_CACHE_DIR` on a machine using the shared mount resolves to a
 *    `<cache>/backtests` that nothing creates.
 * 3. `<cwd>/backtests` — a box with no mount and nothing set, which for
 *    `next start`, `next dev` and the CLI alike is the repo root.
 *
 * **The last branch stays `join(process.cwd(), <literal>)`.** A path call
 * on a fully dynamic argument is the shape Turbopack's module tracer reads
 * as *this route may read anything*, and the literal form is the one it is
 * documented to accept. It is not sufficient on its own — this module reads
 * directories whose names are not known until runtime, which is the whole
 * point of it — so `outputFileTracingExcludes` in `next.config.ts` carries
 * the rest. See the comment there.
 */
export function artifactRoot(): string {
  const explicit = process.env[ARTIFACTS_DIR_VAR];
  if (explicit != null && explicit.length > 0) {
    return resolve(explicit);
  }
  const cache = process.env.BAR_CACHE_DIR;
  if (cache != null && cache.length > 0) {
    return resolve(cache, ARTIFACTS_SUBDIR);
  }
  return join(process.cwd(), ARTIFACTS_SUBDIR);
}

/** Backtest CLI runs, `<playbook>/<run>/` below it — the CLI's default
 *  `--out` and `publishedDir`. */
export const RUNS_DIR = "runs";

/** Labels, charts, probes and one-off studies — anything that is not a
 *  playbook's run. */
export const RESEARCH_DIR = "research";

export const runsRoot = (): string => join(artifactRoot(), RUNS_DIR);

export const researchRoot = (): string => join(artifactRoot(), RESEARCH_DIR);

/**
 * The only folders the root may hold (operator, 2026-10-22). The root is a
 * dataset every chat copies and publishes back, so a folder made at the root
 * by one chat was sent to the NAS and seeded into every chat after it.
 * `makeRunDir` refuses a path outside these and `check:artifacts` lists
 * anything that got there another way.
 */
export const ARTIFACT_TOP_DIRS: readonly string[] = [RUNS_DIR, "parity", RESEARCH_DIR, "scout"];

/**
 * Why `dir` may not be written, or null when it may. A path outside the
 * artifact root is not this rule's business — it is never published.
 * Inside it: never the root itself, never a folder beside the four, and
 * under `runs/` at least `<playbook>/<run>`, so a study cannot pass itself
 * off as a playbook by sitting one level up.
 */
export function artifactPathRefusal(dir: string, root: string = artifactRoot()): string | null {
  const rel = relative(resolve(root), resolve(dir));
  if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
  const allowed = ARTIFACT_TOP_DIRS.map((d) => `${d}/`).join(", ");
  if (rel === "") return `${dir} is the artifact root itself; write under one of ${allowed}`;
  const [top, ...rest] = rel.split(sep);
  if (!ARTIFACT_TOP_DIRS.includes(top)) {
    return `${dir} would make "${top}" at the artifact root, which holds only ${allowed}; a study goes under ${RESEARCH_DIR}/<study>/`;
  }
  if (top === RUNS_DIR && rest.length < 2) {
    return `${dir} is not a run directory: ${RUNS_DIR}/ holds ${RUNS_DIR}/<playbook>/<run>/ only`;
  }
  return null;
}

/** How deep below the root a run directory may sit. `runs/<playbook>/<run>`
 *  is three; the extra level is slack for a trader who groups a sweep under
 *  a fourth. Bounded so a stray symlink cannot walk the filesystem. */
const MAX_DEPTH = 4;

/** The two files a bar-running command writes its header into. `run.json`
 *  is `run` and `lift`; `folds.json` is `walk-forward`. Both carry the same
 *  `buildHeader` object under the same key, so one reader serves both. */
const HEADER_FILES = ["run.json", "folds.json"] as const;

const TRADES_FILE = "trades.jsonl";

/**
 * The header fields this surface renders. A superset would be a lie about
 * what older artifacts carry — `calibratedFor` post-dates the earliest runs
 * on disk and is absent from them, so every field a run may predate is
 * optional and read defensively.
 */
export interface RunSummary {
  /** Path relative to the artifact root, `/`-joined. The run's id on the
   *  wire, and what the trades route resolves back to a directory. */
  runPath: string;
  /** The trailing path segment — what the trader typed into `--out`, or
   *  the generated `<ticker>-<tf>-<from>-<to>-<hash>`. A label, not a key. */
  label: string;
  /** From the header. The grouping key, and never inferred from the path. */
  playbookKey: string;
  playbookVersion: string | null;
  ticker: string;
  timeframe: string;
  from: string;
  to: string;
  /** Null on artifacts written before the field existed. */
  calibratedFor: string | null;
  /** Tick size off the header's contract block — the excursion prices are
   *  derived from it, so a run without one cannot draw MFE/MAE. */
  tickSize: number | null;
  /** `walk-forward` or `run` / `lift`, from which header file was found. */
  kind: "walk-forward" | "run";
  /** Epoch ms of the header file's mtime, for newest-first ordering. */
  modifiedMs: number;
  tradeCount: number;
  /** The header's `resolvedParams` — what the run executed — or null when
   *  the header carries none. Read as a plain object; whether each key still
   *  means anything is the loading surface's question, not this reader's. */
  resolvedParams: ParamValues | null;
  /** The header's `sizing`, in the header's own shape, or null when absent
   *  or not one of the two shapes the CLI writes. */
  sizing: RunSizing | null;
  /** The header's `contract.feePerSide` — 0 on a `--fees off` run. */
  feePerSide: number | null;
}

/** `RunHeader.sizing` as the CLI writes it. */
export type RunSizing = RunHeader["sizing"];

function readSizing(raw: unknown): RunSizing | null {
  if (!isRecord(raw)) return null;
  if (raw.mode === "contracts") {
    const contracts = asNumber(raw.contracts);
    return contracts == null ? null : { mode: "contracts", contracts };
  }
  if (raw.mode === "risk") {
    const riskUsd = asNumber(raw.riskUsd);
    const maxContracts = asNumber(raw.maxContracts);
    return riskUsd == null || maxContracts == null ? null : { mode: "risk", riskUsd, maxContracts };
  }
  return null;
}

function isWindow(v: unknown): v is PauseWindow {
  return isRecord(v) && typeof v.start === "string" && typeof v.end === "string";
}

/**
 * `header.resolvedParams` narrowed to what a `ParamValue` can be: a string,
 * a finite number, a boolean, or a `{start, end}` window list (`pauseWindows`
 * is a common param, so every header carries one). Any other value is
 * dropped rather than handed to the form as if the schema had produced it.
 */
function readResolvedParams(raw: unknown): ParamValues | null {
  if (!isRecord(raw)) return null;
  const out: ParamValues = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (Array.isArray(value) && value.every(isWindow)) {
      out[key] = value.map((w) => ({ start: w.start, end: w.end }));
    }
  }
  return out;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a header file into a summary, or null when it is not one.
 *
 * `null` covers a `labels.json` (a real directory under `backtests/` that
 * carries no header and no trades), a partially-written file from a run
 * still in flight, and anything hand-edited. A directory that cannot be
 * read as a run is skipped rather than surfaced as a broken row — the list
 * is an index, and an entry that cannot be opened is worse than an absence.
 */
async function readRunSummary(
  dir: string,
  runPath: string,
  label: string,
): Promise<RunSummary | null> {
  for (const file of HEADER_FILES) {
    let raw: string;
    let modifiedMs: number;
    try {
      const full = join(dir, file);
      raw = await readFile(full, "utf8");
      modifiedMs = (await stat(full)).mtimeMs;
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.header)) continue;
    const header = parsed.header;

    const playbookKey = asString(header.playbookKey);
    const ticker = asString(header.ticker);
    const timeframe = asString(header.timeframe);
    if (playbookKey == null || ticker == null || timeframe == null) continue;

    // A header with no trades file beside it is a labels run or a crashed
    // one. Either way there is nothing to step through.
    const tradeCount = await countLines(join(dir, TRADES_FILE));
    if (tradeCount == null) continue;

    const contract = isRecord(header.contract) ? header.contract : null;

    return {
      runPath,
      label,
      playbookKey,
      playbookVersion: asString(header.playbookVersion),
      ticker,
      timeframe,
      from: asString(header.from) ?? "",
      to: asString(header.to) ?? "",
      calibratedFor: asString(header.calibratedFor),
      tickSize: contract == null ? null : asNumber(contract.tickSize),
      kind: file === "folds.json" ? "walk-forward" : "run",
      modifiedMs,
      tradeCount,
      resolvedParams: readResolvedParams(header.resolvedParams),
      sizing: readSizing(header.sizing),
      feePerSide: contract == null ? null : asNumber(contract.feePerSide),
    };
  }
  return null;
}

/** Non-blank line count, or null when the file is missing. */
async function countLines(path: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length > 0) count++;
  }
  return count;
}

/**
 * Every run under the artifact root, newest header first.
 *
 * Walks rather than globbing because the depth is not fixed: a run sits at
 * `<playbook>/<run>` today and a trader grouping a sweep puts it one deeper.
 * A directory that is itself a run is not descended into.
 *
 * A root that is absent, or present and unreadable, is an empty list rather
 * than a throw. Staging and prod may read a mount another machine writes, and the
 * subdirectory may not exist yet, or the bind may have gone stale — either
 * is a fact for the panel's empty state, not a 500.
 */
export async function listRuns(): Promise<RunSummary[]> {
  const root = artifactRoot();
  const found: RunSummary[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      const runPath = relative(root, child).split(sep).join("/");
      const summary = await readRunSummary(child, runPath, entry.name);
      if (summary != null) {
        found.push(summary);
        continue; // A run is a leaf; do not descend into it.
      }
      await walk(child, depth + 1);
    }
  }

  await walk(root, 1);
  found.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return found;
}

/**
 * Resolve a wire `runPath` to an absolute directory inside the root, or
 * null when it escapes.
 *
 * **The containment test is on the resolved path, not on the input.** A
 * check for `..` in the string passes `%2e%2e`, a symlink and an absolute
 * path alike; resolving first and then asserting the prefix is the version
 * that holds. The `sep` suffix on the root matters — without it
 * `/srv/backtests-secret` passes a `startsWith("/srv/backtests")` test.
 * The root is whatever `artifactRoot()` resolved, so on the mount the
 * neighbour one `..` away is the Parquet archive itself.
 */
export function resolveRunDir(runPath: string): string | null {
  const root = artifactRoot();
  const full = resolve(root, runPath);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export interface RunTrades {
  summary: RunSummary;
  trades: CliTradeRecord[];
}

/**
 * One run's header and every trade in it.
 *
 * The whole file, not a page: the largest artifact on disk is a few
 * thousand rows of ~700 bytes, the surface's filter and stepper both need
 * the full population to answer *N of M* honestly, and a paged read would
 * put a second reducer on a screen whose whole job is to agree with itself.
 * A line that does not parse is skipped rather than failing the read — one
 * torn line at the end of a run still in flight should not hide the
 * thousands before it.
 */
export async function readRun(runPath: string): Promise<RunTrades | null> {
  const dir = resolveRunDir(runPath);
  if (dir == null) return null;

  const label = runPath.split("/").filter((s) => s.length > 0).pop() ?? runPath;
  const summary = await readRunSummary(dir, runPath, label);
  if (summary == null) return null;

  const raw = await readFile(
    join(dir, TRADES_FILE),
    "utf8",
  );
  const trades: CliTradeRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      trades.push(JSON.parse(line) as CliTradeRecord);
    } catch {
      continue;
    }
  }
  return { summary, trades };
}
