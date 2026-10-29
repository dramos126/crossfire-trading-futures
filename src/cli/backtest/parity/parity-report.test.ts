import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BookBlockedRecord } from "@/lib/trading/backtest-book";
import type { CompareResult, MatchedTrade } from "../commands/compare-command";
import type { BookCellCompare } from "./parity-book";
import type { ParityLogsFile } from "./parity-logs";
import { REPORT_FILE, loadParityDay, writeSessionBars, type LiveRecordFile } from "./parity-report-data";
import { buildReportView } from "./parity-report-model";
import { parityReportCommand, parseParityReportArgs, writeDayReport } from "./parity-report";
import { renderMarkdown } from "./parity-report-html";
import type { PlaybookNames } from "../playbook-label";

// Session 2026-10-12 (Monday): the cash session is 13:30Z–20:00Z (EDT).
const DATE = "2026-10-12";
const ACCOUNT = 90072071;
const ORB = "dep-orb-0001";
const RELAY = "dep-relay-0002";
const SB = "dep-sb-0003";
const at = (hhmmZ: string) => `${DATE}T${hhmmZ}:00.000Z`;
// `gamma-hold` is left out: a key with no loaded module reads as itself.
// `Delta Structure Break` carries no instrument, so the label appends one.
const PLAYBOOKS: PlaybookNames = new Map([
  ["alpha-breakout-capped", "Alpha Breakout (capped) — MNQ"],
  ["epsilon-close-break", "Epsilon Close Break — MES"],
  ["delta-structure-break", "Delta Structure Break"],
]);
const ORB_LABEL = "Alpha Breakout (capped) — MNQ (deployment …0001)";
const RELAY_LABEL = "Epsilon Close Break — MES (deployment …0002)";
const SB_LABEL = "Delta Structure Break — MES (deployment …0003)";

let root: string;
const warnings: string[] = [];
const warn = (m: string) => {
  warnings.push(m);
};

function emptyCompare(): CompareResult {
  return {
    matched: [],
    liveOnly: [],
    liveUnjoinable: [],
    backtestOnly: [],
    summary: {
      matched: 0,
      liveOnly: 0,
      liveUnjoinable: 0,
      backtestOnly: 0,
      exitReasonAgreement: 0,
      avgFillSlippageTicks: 0,
      worstFillSlippageTicks: 0,
    },
  };
}

function cell(deploymentId: string, strategyKey: string, ticker: string, fields: Partial<BookCellCompare>): BookCellCompare {
  return {
    deploymentId,
    strategyKey,
    ticker,
    inBook: true,
    compare: emptyCompare(),
    notCompared: [],
    missed: [],
    excused: [],
    endOfData: 0,
    extra: [],
    orderDifferences: [],
    blockedInBook: [],
    ...fields,
  };
}

const matchedWithSlippage: MatchedTrade = {
  signalBarTs: at("14:09"),
  side: 1,
  liveTradeId: 14,
  backtestTradeId: 2,
  liveEntryPrice: 30880.25,
  backtestEntryPrice: 30880.5,
  fillSlippageTicks: 1,
  liveExitReason: "time_window_close",
  backtestExitReason: "stop_loss",
  exitReasonAgreement: false,
};

const blockBySb: BookBlockedRecord = {
  deploymentId: SB,
  strategyKey: "delta-structure-break",
  ticker: "/MES",
  signalBarTs: at("14:10"),
  sessionDate: DATE,
  gate: "contract_held",
  holderDeploymentId: RELAY,
  contested: true,
  releaseSensitive: false,
};

/** One account whose cells carry one of every kind of difference. */
function bookCells(): BookCellCompare[] {
  const missedRow = {
    tradeId: 5,
    signalBarTs: at("15:00"),
    sessionDate: DATE,
    side: 0,
    entryPrice: 7860,
    exitReason: "take_profit",
    liveSkipReason: "vwap: price under VWAP",
  };
  const excusedRow = { ...missedRow, tradeId: 6, signalBarTs: at("16:00"), liveSkipReason: null };
  return [
    cell(ORB, "alpha-breakout-capped", "/MNQ", {
      compare: { ...emptyCompare(), matched: [matchedWithSlippage], liveUnjoinable: [{ tradeId: 30, strategyKey: "alpha-breakout-capped", ticker: "MNQ", side: 0, signalBarTs: null, entryPrice: 30900, exitReason: "stop_loss" }] },
      notCompared: [
        { live: { tradeId: 31, strategyKey: "alpha-breakout-capped", ticker: "MNQ", side: 0, signalBarTs: at("19:50"), entryPrice: 30890, exitReason: "time_window_close" }, reason: "book_end_of_data" },
      ],
      endOfData: 1,
    }),
    cell(RELAY, "epsilon-close-break", "/MES", {
      compare: { ...emptyCompare(), backtestOnly: [missedRow, excusedRow] },
      missed: [missedRow],
      excused: [{ row: excusedRow, contested: true, releaseSensitive: false }],
      extra: [{ tradeId: 17, strategyKey: "epsilon-close-break", ticker: "MES", side: 1, signalBarTs: at("17:30"), entryPrice: 7850, exitReason: "stop_loss", reason: "no_backtest_entry" }],
    }),
    cell(SB, "delta-structure-break", "/MES", {
      blockedInBook: [blockBySb],
      orderDifferences: [
        {
          live: { tradeId: 18, strategyKey: "delta-structure-break", ticker: "MES", side: 1, signalBarTs: at("18:00"), entryPrice: 7849, exitReason: "stop_loss", reason: "no_backtest_entry" },
          block: { ...blockBySb, signalBarTs: at("18:00"), gate: "stale_latch", contested: false },
        },
      ],
    }),
    cell("dep-gone-0004", "tom-hold", "/MNQ", {
      inBook: false,
      notCompared: [
        { live: { tradeId: 40, strategyKey: "tom-hold", ticker: "MNQ", side: 0, signalBarTs: at("19:00"), entryPrice: 30870, exitReason: "take_profit" }, reason: "not_in_book" },
      ],
    }),
  ];
}

/** Ten differences: exit + slippage on the match, unjoinable, end of data,
 *  missed, excused, extra, blocked, order difference, not in the book. */
const DIFFERENCE_COUNT = 10;

function bookLine(cells: BookCellCompare[] | null, refusal: string | null = null) {
  return {
    mode: "book",
    sessionDate: DATE,
    accountId: ACCOUNT,
    status: cells == null ? "refused" : "compared",
    refusal,
    cells: [ORB, RELAY, SB],
    liveLegs: [ORB, RELAY, SB],
    runDir: cells == null ? null : `/somewhere/else/parity/${DATE}/book/${ACCOUNT}`,
    activeSource: "prior_state",
    phaseSeedSource: "first_live_trade",
    matched: 1,
    missed: 1,
    excused: 1,
    extra: 1,
    orderDifferences: 1,
    blockedInBook: 1,
    contestedDifferences: 2,
    endOfData: 1,
    liveNotCompared: 2,
    liveUnjoinable: 1,
    liveNotClosed: 0,
    exitReasonDisagreements: 1,
    avgFillSlippageTicks: 1,
    worstFillSlippageTicks: 1,
    barTail: null,
    seamWarnings: [],
    snapshotTakenAt: null,
    gitSha: null,
    gitDirty: null,
    generatedAt: at("21:00"),
    compare: cells,
  };
}

function runTrade(tradeId: number, deploymentId: string, ticker: string, signal: string, exit: string, fields: Record<string, unknown> = {}) {
  return {
    tradeId,
    deploymentId,
    strategyKey: "x",
    ticker,
    signalBarTs: at(signal),
    side: 1,
    contracts: 1,
    entryPrice: 30880.5,
    exitTs: at(exit),
    exitPrice: 30889.75,
    exitReason: "stop_loss",
    pnlNetDollars: -19.74,
    contested: false,
    releaseSensitive: false,
    endOfData: false,
    ...fields,
  };
}

const LIVE: LiveRecordFile = {
  sessionDate: DATE,
  trades: [
    {
      id: 14,
      deploymentId: ORB,
      accountId: ACCOUNT,
      strategyKey: "alpha-breakout-capped",
      ticker: "/MNQ",
      side: 1,
      size: 1,
      status: "closed",
      signalBarTs: at("14:09"),
      entryPrice: 30880.25,
      entryFilledAt: at("14:10"),
      exitPrice: 30890,
      exitFilledAt: at("19:55"),
      exitReasonCode: "time_window_close",
      pnlDollars: -20.99,
      entrySlippageTicks: 0,
    },
  ],
  skips: [],
};

function writeDay(dir: string, opts: { book?: unknown; live?: boolean; bars?: boolean } = {}): void {
  const bookDir = path.join(dir, "book", String(ACCOUNT));
  mkdirSync(bookDir, { recursive: true });
  writeFileSync(
    path.join(dir, "book", "compare.json"),
    JSON.stringify(opts.book ?? { sessionDate: DATE, mode: "book", accounts: [bookLine(bookCells())] }),
  );
  writeFileSync(
    path.join(bookDir, "run.json"),
    JSON.stringify({
      header: {
        cells: [
          { deploymentId: ORB, strategyKey: "alpha-breakout-capped", ticker: "/MNQ", timeframe: "1m" },
          { deploymentId: RELAY, strategyKey: "epsilon-close-break", ticker: "/MES", timeframe: "5m" },
          { deploymentId: SB, strategyKey: "delta-structure-break", ticker: "/MES", timeframe: "5m" },
        ],
        contests: [{}],
      },
      summary: { book: { netDollars: -267.18 } },
    }),
  );
  writeFileSync(
    path.join(bookDir, "trades.jsonl"),
    [
      runTrade(2, ORB, "/MNQ", "14:09", "19:55"),
      runTrade(7, ORB, "/MNQ", "19:50", "19:59", { endOfData: true }),
      runTrade(5, RELAY, "/MES", "15:00", "15:30", { side: 0 }),
      runTrade(6, RELAY, "/MES", "16:00", "16:30", { side: 0 }),
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  writeFileSync(path.join(bookDir, "blocked.jsonl"), `${JSON.stringify(blockBySb)}\n`);
  if (opts.bars !== false) {
    const bars = [];
    for (let m = 0; m < 600; m++) {
      const t = Date.parse(at("13:00")) + m * 60_000;
      bars.push({ timestamp: new Date(t).toISOString(), open: 30880, high: 30881, low: 30879, close: 30880.5, volume: 1 });
    }
    writeSessionBars(bookDir, {
      sessionDate: DATE,
      series: [
        { ticker: "MNQ", timeframe: "1m", bars: bars.map((b) => [Date.parse(b.timestamp), b.open, b.high, b.low, b.close]) },
      ],
    });
  }
  if (opts.live !== false) writeFileSync(path.join(dir, "live.json"), JSON.stringify(LIVE));
  writeFileSync(path.join(dir, "summary.md"), "# Live against backtest, session 2026-10-12\n\nSUMMARY-SENTINEL\n");
}

/** The engine's lines for the fixture's legs: one in the extra entry's window,
 *  an account line in the same window, and an error no difference holds. */
const LOGS: ParityLogsFile = {
  sessionDate: DATE,
  unavailable: null,
  legs: [
    { deploymentId: ORB, accountId: ACCOUNT, strategyKey: "alpha-breakout-capped", ticker: "/MNQ", barMinutes: 1 },
    { deploymentId: RELAY, accountId: ACCOUNT, strategyKey: "epsilon-close-break", ticker: "/MES", barMinutes: 5 },
    { deploymentId: SB, accountId: ACCOUNT, strategyKey: "delta-structure-break", ticker: "/MES", barMinutes: 5 },
  ],
  lines: [
    { at: `${DATE}T17:35:00.250Z`, deploymentId: RELAY, accountId: ACCOUNT, severity: "info", event: "entry_submitted", message: "SELL 1 /MES | TP:-40 SL:20" },
    { at: `${DATE}T17:35:00.400Z`, deploymentId: null, accountId: ACCOUNT, severity: "warn", event: "ws_subscribe_failed", message: "subscribeAccount(…2071) failed" },
    // An engine line naming no account: it belongs to whatever window it falls in.
    { at: `${DATE}T17:35:00.500Z`, deploymentId: null, accountId: null, severity: "warn", event: "broker_code_unknown", message: "GatewayUserOrder id=1: unknown status=6" },
    { at: `${DATE}T18:30:00.000Z`, deploymentId: ORB, accountId: ACCOUNT, severity: "error", event: "entry_order_rejected", message: "Entry order rejected: You must enable Auto OCO Brackets." },
    { at: `${DATE}T19:30:00.000Z`, deploymentId: null, accountId: null, severity: "warn", event: "frame_unparseable", message: "GatewayUserOrder: no recognizable payload" },
  ],
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "parity-report-test-"));
  warnings.length = 0;
});

afterEach(() => {
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

function dayDir(date = DATE): string {
  return path.join(root, date);
}

describe("writeDayReport", () => {
  it("is self-contained: no network address in any src or href, no external stylesheet or script", () => {
    writeDay(dayDir());
    expect(writeDayReport(dayDir(), DATE, PLAYBOOKS, warn)).toBe(true);
    const html = readFileSync(path.join(dayDir(), REPORT_FILE), "utf8");

    expect(html).toContain("<svg class=\"chart\"");
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?\s*(https?:)?\/\//i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]*\bsrc=/i);
    expect(warnings).toEqual([]);
  });

  it("lists every difference in the compare data, each once, grouped by playbook in time order", () => {
    writeDay(dayDir());
    const view = buildReportView(loadParityDay(dayDir(), DATE), PLAYBOOKS);
    const [account] = view.accounts ?? [];
    const items = account.groups.flatMap((g) => g.items);

    expect(items).toHaveLength(DIFFERENCE_COUNT);
    // The app's display name, never the key; the account is the section's heading.
    expect(account.groups.map((g) => g.name)).toEqual([
      ORB_LABEL,
      RELAY_LABEL,
      SB_LABEL,
      "tom-hold — MNQ (deployment …0004)",
    ]);
    for (const g of account.groups) {
      expect(g.items.map((i) => i.ms)).toEqual([...g.items.map((i) => i.ms)].sort((a, b) => a - b));
    }
    const text = items.map((i) => i.text).join("\n");
    expect(text).toContain("live exited on Time Window Close (TWC) and the book on Stop Loss (SL)");
    expect(text).toContain("live filled 1 tick worse than the book (30,880.25 against 30,880.50)");
    expect(text).toContain("Live trade 30 has no signal bar recorded");
    expect(text).toContain("still open when the bars ran out, so neither was compared");
    expect(text).toContain("live skipped it: vwap: price under VWAP");
    expect(text).toContain("so it is not counted as a miss");
    expect(text).toContain("Live went short at 13:30 ET (trade 17) and the book did not enter, and nothing in the book blocked it.");
    expect(text).toContain(
      `Neither entered at 10:10 ET: the book had a signal, but ${RELAY_LABEL} was already holding a position on MES`,
    );
    expect(text).toContain("Live went short at 14:00 ET (trade 18); the book did not, because its signal was set aside");
    expect(text).toContain("this playbook was not in the book");

    const html = readFileSync((writeDayReport(dayDir(), DATE, PLAYBOOKS, warn), path.join(dayDir(), REPORT_FILE)), "utf8");
    for (const item of items) {
      const escaped = item.text.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");
      expect(html).toContain(escaped);
    }
    // The page names a playbook as the app does; its key appears nowhere on it.
    expect(html).toContain(RELAY_LABEL);
    expect(html).not.toContain("epsilon-close-break");
    // Each difference that names a mark is a control that highlights it.
    expect(html.match(/<button type="button" class="diff"/g)?.length).toBe(items.filter((i) => i.marks.length > 0).length);
  });

  it("draws live and backtest with different shapes and different colours, long pointing up, with a legend", () => {
    writeDay(dayDir());
    writeDayReport(dayDir(), DATE, PLAYBOOKS, warn);
    const html = readFileSync(path.join(dayDir(), REPORT_FILE), "utf8");
    const charts = html.match(/<svg class="chart"[\s\S]*?<\/svg>/g) ?? [];
    const marks = charts.join("").match(/<g class="mk (live|backtest)"[\s\S]*?<\/g>/g) ?? [];
    const glyphs = (source: string) =>
      marks
        .filter((m) => m.startsWith(`<g class="mk ${source}"`))
        .map((m) => {
          const glyph = /<(path|circle|rect) class="glyph"(?: d="([^"]*)")?/.exec(m);
          return glyph?.[1] === "path" ? `path:${(glyph[2] ?? "").split("L").length}` : (glyph?.[1] ?? "none");
        });

    // Live: a three-point triangle at entry and a circle at exit; the backtest
    // a seven-point arrow and a square. No shape is shared.
    expect(new Set(glyphs("live"))).toEqual(new Set(["path:3", "circle"]));
    expect(new Set(glyphs("backtest"))).toEqual(new Set(["path:7", "rect"]));
    // Colour comes from the series class, and the two series take two tokens.
    expect(html).toMatch(/\.live \.glyph \{ fill: var\(--series-live\); \}/);
    expect(html).toMatch(/\.backtest \.glyph \{ fill: var\(--series-backtest\); \}/);
    expect(html).toMatch(/--series-live: oklch\(0\.65 0\.18 250\)/);
    expect(html).toMatch(/--series-backtest: oklch\(0\.66 0\.16 55\)/);
    expect(html).toMatch(/@media \(prefers-color-scheme: light\)[\s\S]*--series-live: oklch\(0\.55 0\.19 255\)/);
    // A short's live triangle points down: its apex is below its base.
    const short = marks.find((m) => m.startsWith('<g class="mk live"') && m.includes('aria-label="Live short entry"'));
    const [apex, base] = (/d="M[\d.]+ ([\d.]+)L[\d.]+ ([\d.]+)/.exec(short ?? "") ?? []).slice(1).map(Number);
    expect(apex).toBeGreaterThan(base);
    expect(html).toContain("Live entry");
    expect(html).toContain("Backtest entry");
    expect(html).toContain("Blocked signal");
  });

  it("names the blocked signal's holder in its tooltip", () => {
    writeDay(dayDir());
    const view = buildReportView(loadParityDay(dayDir(), DATE), PLAYBOOKS);
    const blocked = Object.entries(view.tips).filter(([mark]) => mark.includes("-X"));
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0][1].rows).toContainEqual(["Held by", RELAY_LABEL]);
  });

  it("aggregates a run that read 1m bars into 5-minute candles", () => {
    writeDay(dayDir());
    const [account] = buildReportView(loadParityDay(dayDir(), DATE), PLAYBOOKS).accounts ?? [];
    const mnq = account.charts.find((c) => c.ticker === "MNQ");
    expect(mnq?.candleMinutes).toBe(5);
    expect(mnq?.barsNote).toBeNull();
    expect(mnq?.candles.every((c) => c.ms % 300_000 === 0)).toBe(true);
  });

  it("says what is missing rather than inventing it when live detail and bars were not saved", () => {
    writeDay(dayDir(), { live: false, bars: false });
    const view = buildReportView(loadParityDay(dayDir(), DATE), PLAYBOOKS);
    const [account] = view.accounts ?? [];
    expect(view.notes.join(" ")).toMatch(/Live exits, contract counts and P&L were not saved/);
    expect(view.notes.join(" ")).toMatch(/The engine's logs were not saved with this day's run/);
    expect(account.charts.every((c) => c.candles.length === 0 && c.barsNote != null)).toBe(true);
    expect(account.tiles.find((t) => t.label === "Live P&L")?.value).toBe("—");
  });

  it("a day whose files cannot be read gets a plain page with its summary and a warning, never a throw", () => {
    writeDay(dayDir(), { book: { sessionDate: DATE, mode: "book", accounts: [{ ...bookLine(bookCells()), matched: "three" }] } });

    expect(writeDayReport(dayDir(), DATE, PLAYBOOKS, warn)).toBe(false);

    const html = readFileSync(path.join(dayDir(), REPORT_FILE), "utf8");
    expect(html).toContain("The report for this day could not be built");
    expect(html).toContain("accounts[0].matched");
    expect(html).toContain("SUMMARY-SENTINEL");
    expect(warnings).toHaveLength(1);
  });

  it("renders notes.md escaped, so a <script> in the notes is text on the page", () => {
    writeDay(dayDir());
    writeFileSync(
      path.join(dayDir(), "notes.md"),
      "# Notes\n\n## 2026-10-12 — a look\n\n- **09:50 ET** the `entry_submitted` line, *not* filled\n- <script>alert(1)</script>\n\nA paragraph & more.\n",
    );
    writeDayReport(dayDir(), DATE, PLAYBOOKS, warn);
    const html = readFileSync(path.join(dayDir(), REPORT_FILE), "utf8");

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('<section class="panel" id="notes"><h3>Notes</h3>');
    expect(html).toContain("<h4>2026-10-12 — a look</h4>");
    expect(html).toContain("<li><strong>09:50 ET</strong> the <code>entry_submitted</code> line, <em>not</em> filled</li>");
    expect(html).toContain("<p>A paragraph &amp; more.</p>");
    // Near the top: before the first account's section.
    expect(html.indexOf('id="notes"')).toBeLessThan(html.indexOf('<section class="account"'));
  });

  it("puts under each difference the lines live logged in its window, and says when it logged nothing", () => {
    writeDay(dayDir());
    writeFileSync(path.join(dayDir(), "logs.json"), JSON.stringify(LOGS));
    const [account] = buildReportView(loadParityDay(dayDir(), DATE), PLAYBOOKS).accounts ?? [];
    const items = account.groups.flatMap((g) => g.items);

    const extra = items.find((i) => i.text.includes("(trade 17)"));
    expect(extra?.logs).toEqual({
      lines: [
        "13:35:00 ET entry_submitted: SELL 1 /MES | TP:-40 SL:20",
        "13:35:00 ET ws_subscribe_failed (warn): subscribeAccount(…2071) failed",
        "13:35:00 ET broker_code_unknown (warn): GatewayUserOrder id=1: unknown status=6",
      ],
      empty: null,
    });
    const missed = items.find((i) => i.text.includes("live skipped it: vwap"));
    expect(missed?.logs).toEqual({ lines: [], empty: "Live logged nothing for this playbook from 11:00 to 11:11 ET." });
    // A bar not recorded has no window to cut.
    expect(items.find((i) => i.text.includes("Live trade 30"))?.logs).toBeNull();

    writeDayReport(dayDir(), DATE, PLAYBOOKS, warn);
    const html = readFileSync(path.join(dayDir(), REPORT_FILE), "utf8");
    expect(html).toContain('<ul class="log-lines"><li>13:35:00 ET entry_submitted: SELL 1 /MES | TP:-40 SL:20</li>');
    expect(html).toContain('<p class="log-empty">Live logged nothing for this playbook from 11:00 to 11:11 ET.</p>');
  });

  it("lists a warn or error line outside every difference window under the irregularities, and none inside one", () => {
    writeDay(dayDir());
    writeFileSync(path.join(dayDir(), "logs.json"), JSON.stringify(LOGS));
    const view = buildReportView(loadParityDay(dayDir(), DATE), PLAYBOOKS);

    expect(view.irregularities).toEqual([
      "14:30:00 ET · Alpha Breakout (capped) — MNQ (deployment …0001, account …2071) · entry_order_rejected (error): Entry order rejected: You must enable Auto OCO Brackets.",
      "15:30:00 ET · the engine · frame_unparseable (warn): GatewayUserOrder: no recognizable payload",
    ]);
    writeDayReport(dayDir(), DATE, PLAYBOOKS, warn);
    expect(readFileSync(path.join(dayDir(), REPORT_FILE), "utf8")).toContain("Engine warnings and errors");
  });

  it("gives no log lines, rather than 'logged nothing', to a deployment logs.json does not cover", () => {
    writeDay(dayDir());
    // A playbook-only re-run whose logs were read for the live legs alone.
    writeFileSync(path.join(dayDir(), "logs.json"), JSON.stringify({ ...LOGS, legs: LOGS.legs.filter((l) => l.deploymentId !== SB) }));
    const [account] = buildReportView(loadParityDay(dayDir(), DATE), PLAYBOOKS).accounts ?? [];
    const sb = account.groups.find((g) => g.name === SB_LABEL);
    expect(sb?.items.length).toBeGreaterThan(0);
    expect(sb?.items.every((i) => i.logs == null)).toBe(true);
  });

  it("nests bold and italic properly in notes, leaving a marker that would cross a tag as text", () => {
    expect(renderMarkdown("**a *b** c*")).toBe("<p><strong>a *b</strong> c*</p>");
    expect(renderMarkdown("**bold *and italic* inside**")).toBe("<p><strong>bold <em>and italic</em> inside</strong></p>");
  });

  it("places a not-closed live trade on its bar when compare.json spells the instant as SQLite does", () => {
    const tz = process.env.TZ;
    // Read as local time, the SQLite spelling would land four hours off here.
    process.env.TZ = "America/New_York";
    try {
      mkdirSync(dayDir(), { recursive: true });
      writeFileSync(
        path.join(dayDir(), "compare.json"),
        JSON.stringify({
          legs: [
            {
              deploymentId: ORB, accountId: ACCOUNT, strategyKey: "alpha-breakout-capped", ticker: "/MNQ",
              status: "compared", refusal: null, runDir: null, matched: 0, liveOnly: 0, backtestOnly: 0, liveNotClosed: 1,
              avgFillSlippageTicks: null, worstFillSlippageTicks: null, seamWarning: null,
              unclosed: [{ tradeId: 19, status: "entry_failed", signalBarTs: `${DATE} 13:49:00` }],
              compare: emptyCompare(),
            },
          ],
        }),
      );
      const [leg] = buildReportView(loadParityDay(dayDir(), DATE), PLAYBOOKS).legs ?? [];
      // A leg sits under no account heading, so its label names the account.
      expect(leg.title).toBe("Alpha Breakout (capped) — MNQ (deployment …0001, account …2071)");
      expect(leg.items.map((i) => i.text)).toEqual(["Live trade 19 at 09:49 ET is entry_failed, not closed, so it was not compared."]);
    } finally {
      process.env.TZ = tz;
    }
  });

  it("reads a notes.md that is not a readable file as no notes, with a warning, never a throw", () => {
    writeDay(dayDir());
    mkdirSync(path.join(dayDir(), "notes.md"));
    expect(writeDayReport(dayDir(), DATE, PLAYBOOKS, warn)).toBe(true);
    expect(readFileSync(path.join(dayDir(), REPORT_FILE), "utf8")).not.toContain('id="notes"');
    expect(warnings.join("\n")).toMatch(/notes\.md could not be read/);
  });

  it("says the logs were unavailable rather than that live logged nothing", () => {
    writeDay(dayDir());
    writeFileSync(
      path.join(dayDir(), "logs.json"),
      JSON.stringify({ ...LOGS, lines: [], unavailable: "Engine logs were unavailable: the snapshot has no engine_logs table, so no difference carries what live logged." }),
    );
    const view = buildReportView(loadParityDay(dayDir(), DATE), PLAYBOOKS);
    expect(view.notes).toContain(
      "Engine logs were unavailable: the snapshot has no engine_logs table, so no difference carries what live logged.",
    );
    expect(view.irregularities).toBeNull();
    expect((view.accounts ?? []).flatMap((a) => a.groups.flatMap((g) => g.items)).every((i) => i.logs == null)).toBe(true);
  });

  it("shows a refused account's reason and no chart", () => {
    writeDay(dayDir(), { book: { sessionDate: DATE, mode: "book", accounts: [bookLine(null, "the snapshot holds no playbook")] } });
    writeDayReport(dayDir(), DATE, PLAYBOOKS, warn);
    const html = readFileSync(path.join(dayDir(), REPORT_FILE), "utf8");
    expect(html).toContain("Not compared: the snapshot holds no playbook");
    expect(html).not.toContain("<svg class=\"chart\"");
  });
});

describe("parityReportCommand", () => {
  const savedDb = process.env.TRADING_DB_PATH;
  afterEach(() => {
    process.env.TRADING_DB_PATH = savedDb;
  });

  it("rebuilds every day and the index from disk alone, newest first, opening no database", () => {
    const missingDb = path.join(root, "never-created.db");
    process.env.TRADING_DB_PATH = missingDb;
    writeDay(dayDir("2026-10-09"));
    writeDay(dayDir(DATE));

    const out = parityReportCommand({ date: null }, PLAYBOOKS, root, warn);

    expect(out.split("\n")).toEqual([
      path.join(root, DATE, REPORT_FILE),
      path.join(root, "2026-10-09", REPORT_FILE),
      path.join(root, "index.html"),
    ]);
    expect(existsSync(path.join(root, "2026-10-09", REPORT_FILE))).toBe(true);
    const index = readFileSync(path.join(root, "index.html"), "utf8");
    expect(index.indexOf(`href="${DATE}/report.html"`)).toBeLessThan(index.indexOf('href="2026-10-09/report.html"'));
    expect(index).toContain("-$267.18");
    expect(existsSync(missingDb)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it("rebuilds one date with --date, and refuses a date with no record", () => {
    writeDay(dayDir(DATE));
    expect(parityReportCommand(parseParityReportArgs(["--date", DATE]), PLAYBOOKS, root, warn).split("\n")[0]).toBe(
      path.join(root, DATE, REPORT_FILE),
    );
    expect(() => parityReportCommand({ date: "2026-10-01" }, PLAYBOOKS, root, warn)).toThrow(/No parity record for session 2026-10-01/);
    expect(() => parseParityReportArgs(["--mode", "book"])).toThrow(/takes only --date/);
  });

  it("rebuilds a day with its notes and logs from disk alone, and marks the day in the index", () => {
    const missingDb = path.join(root, "never-created.db");
    process.env.TRADING_DB_PATH = missingDb;
    writeDay(dayDir(DATE));
    writeDay(dayDir("2026-10-09"));
    writeFileSync(path.join(dayDir(DATE), "logs.json"), JSON.stringify(LOGS));
    writeFileSync(path.join(dayDir(DATE), "notes.md"), "## Appended later\n\nOperator enabled Auto OCO.\n");

    parityReportCommand(parseParityReportArgs(["--date", DATE]), PLAYBOOKS, root, warn);

    const html = readFileSync(path.join(dayDir(DATE), REPORT_FILE), "utf8");
    expect(html).toContain("<p>Operator enabled Auto OCO.</p>");
    expect(html).toContain("13:35:00 ET entry_submitted: SELL 1 /MES | TP:-40 SL:20");
    const index = readFileSync(path.join(root, "index.html"), "utf8");
    expect(index).toContain(`<a href="${DATE}/report.html#notes">Notes</a>`);
    expect(index).not.toContain('href="2026-10-09/report.html#notes"');
    expect(existsSync(missingDb)).toBe(false);
  });

  it("fails the exit when a day fell back to the plain page", () => {
    writeDay(dayDir(DATE), { book: { accounts: "not a list" } });
    parityReportCommand({ date: DATE }, PLAYBOOKS, root, warn);
    expect(process.exitCode).toBe(1);
  });
});
