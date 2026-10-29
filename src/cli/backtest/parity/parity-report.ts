/**
 * `parity-report [--date D]` — the parity check's human-readable pages, built
 * from what a date directory holds: `report.html` per day and `index.html`
 * over every day. Re-run it after appending to a day's `notes.md` to show the
 * note. No database, no bars, no Topstep, so it takes neither the
 * run lock nor a CPU target; the playbook registry is loaded only to name
 * each playbook as the app does. `parity-day` calls the same two functions as its
 * last step, so a rebuilt page is the page the run wrote.
 *
 * A day whose report cannot be built gets a plain page saying why, with its
 * `summary.md`: the comparison is the record, the page is a view of it, and a
 * broken view must never cost the record.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { artifactRoot } from "@/lib/trading/backtest-artifacts";
import { CliError } from "../cli-error";
import { writeFileAtomically } from "../output";
import { renderFallback, renderIndex, renderReport } from "./parity-report-html";
import { INDEX_FILE, REPORT_FILE, listParityDates, loadParityDay, readNotes, readSummary } from "./parity-report-data";
import { buildReportView, indexRow, type IndexRow } from "./parity-report-model";
import type { PlaybookNames } from "../playbook-label";
import { parseSessionDate } from "../session-dates";

export const PARITY_DIR = "parity";

export interface ParityReportArgs {
  /** Null rebuilds every day. */
  date: string | null;
}

export function parseParityReportArgs(argv: string[]): ParityReportArgs {
  let date: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (flag !== "--date") throw new CliError(`Unknown flag "${flag}". parity-report takes only --date`);
    if (value == null || value.startsWith("--")) throw new CliError(`Flag "${flag}" needs a value`);
    date = parseSessionDate(value, "--date");
  }
  return { date };
}

export type Warn = (message: string) => void;

const stderrWarn: Warn = (message) => {
  process.stderr.write(`${message}\n`);
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The day's page, written into `dateDir`. Returns false when it fell back to
 * the plain page; never throws for a failure to build, only warns.
 */
export function writeDayReport(dateDir: string, date: string, playbooks: PlaybookNames, warn: Warn = stderrWarn): boolean {
  const file = path.join(dateDir, REPORT_FILE);
  let html: string;
  let built = true;
  try {
    html = renderReport(buildReportView(loadParityDay(dateDir, date, warn), playbooks));
  } catch (err) {
    built = false;
    warn(`The parity report for ${date} could not be built, so it is a plain page with the summary: ${messageOf(err)}`);
    html = renderFallback(date, messageOf(err), readSummary(dateDir), readNotes(dateDir, warn));
  }
  try {
    writeFileAtomically(file, html);
  } catch (err) {
    warn(`The parity report for ${date} could not be written: ${messageOf(err)}`);
    return false;
  }
  return built;
}

/**
 * `index.html` over every committed day, newest first. `pending` is a day
 * still in its staging directory — the run building it — read from there
 * under its own date. A day that cannot be read is a row saying so.
 */
export function buildIndexHtml(parityRoot: string, pending: { date: string; dir: string } | null = null): string {
  const dates = new Set(listParityDates(parityRoot));
  if (pending != null) dates.add(pending.date);
  const rows: IndexRow[] = [...dates]
    .sort()
    .reverse()
    .map((date) => {
      const dir = pending?.date === date ? pending.dir : path.join(parityRoot, date);
      try {
        // The day's own page already warned about its notes.
        return indexRow(loadParityDay(dir, date, () => {}));
      } catch (err) {
        return {
          date,
          accounts: null,
          matched: null,
          missed: null,
          extra: null,
          blocked: null,
          livePnl: "—",
          livePnlTone: null,
          bookPnl: "—",
          bookPnlTone: null,
          note: `This day's files could not be read: ${messageOf(err)}`,
          hasNotes: readNotes(dir, () => {}) != null,
        };
      }
    });
  return renderIndex(rows);
}

/** Writes the index; a failure is a warning, never the caller's failure. */
export function writeIndex(parityRoot: string, html: string, warn: Warn = stderrWarn): void {
  try {
    writeFileAtomically(path.join(parityRoot, INDEX_FILE), html);
  } catch (err) {
    warn(`The parity index could not be written: ${messageOf(err)}`);
  }
}

export function parityReportCommand(
  args: ParityReportArgs,
  playbooks: PlaybookNames,
  parityRoot: string = path.join(artifactRoot(), PARITY_DIR),
  warn: Warn = stderrWarn,
): string {
  if (!existsSync(parityRoot)) {
    throw new CliError(`No parity record at ${parityRoot}: parity-day has not written a day there yet.`);
  }
  const dates = args.date == null ? listParityDates(parityRoot) : [args.date];
  if (args.date != null && !existsSync(path.join(parityRoot, args.date))) {
    throw new CliError(`No parity record for session ${args.date} under ${parityRoot}.`);
  }
  const written: string[] = [];
  let fellBack = 0;
  for (const date of dates) {
    const dir = path.join(parityRoot, date);
    if (!writeDayReport(dir, date, playbooks, warn)) fellBack++;
    written.push(path.join(dir, REPORT_FILE));
  }
  writeIndex(parityRoot, buildIndexHtml(parityRoot), warn);
  if (fellBack > 0) process.exitCode = 1;
  return [...written, path.join(parityRoot, INDEX_FILE)].join("\n");
}
