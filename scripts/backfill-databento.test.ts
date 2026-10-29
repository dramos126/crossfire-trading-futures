import { describe, expect, it, vi } from "vitest";

import {
  coverageAgeDays,
  coverageEndUtc,
  daysInclusive,
  estimateCostUsd,
  formatDiscordMessage,
  lastBarIso,
  mergeBars,
  parseArgs,
  parseAvailableEnd,
  parseNdjsonToBars,
  priceFromFixed,
  shouldSkipYear,
  yearWindowUtc,
} from "./backfill-databento";
import type { RunSummary } from "./backfill-databento";

describe("mergeBars", () => {
  const bar = (minute: number, close: number) => ({
    tsUtc: BigInt(minute) * BigInt(60_000_000_000),
    open: close,
    high: close,
    low: close,
    close,
    volume: BigInt(1),
    symbol: "NQ.c.0",
  });

  it("keeps bars outside the fetched window — the 2026-09-10 data loss", () => {
    // A year file holding November and December, re-fetched for January only.
    // Before the fix the existing bars were never read, so this wrote back the
    // January window alone and dropped the rest of the year.
    const existing = [bar(100, 1), bar(101, 2)];
    const fetched = [bar(1, 3), bar(2, 4)];

    const merged = mergeBars(existing, fetched);

    expect(merged).toHaveLength(4);
    expect(merged.map((b) => b.tsUtc)).toEqual([
      bar(1, 0).tsUtc,
      bar(2, 0).tsUtc,
      bar(100, 0).tsUtc,
      bar(101, 0).tsUtc,
    ]);
  });

  it("counts only net-new rows, so a re-fetch of cached bars adds none", () => {
    const existing = [bar(1, 1), bar(2, 2)];
    const merged = mergeBars(existing, [bar(1, 9), bar(2, 9)]);

    expect(merged).toHaveLength(2);
    expect(merged.length - existing.length).toBe(0);
  });

  it("lets the existing bar win a collision, so a re-fetch cannot rewrite history", () => {
    const merged = mergeBars([bar(1, 111)], [bar(1, 999)]);

    expect(merged).toHaveLength(1);
    expect(merged[0].close).toBe(111);
  });

  it("sorts the union, so an out-of-order fetch still writes a sorted file", () => {
    const merged = mergeBars([bar(50, 1)], [bar(90, 2), bar(10, 3)]);

    expect(merged.map((b) => b.close)).toEqual([3, 1, 2]);
  });

  it("handles an empty existing file as a plain full-fetch", () => {
    expect(mergeBars([], [bar(1, 1), bar(2, 2)])).toHaveLength(2);
  });
});

describe("priceFromFixed", () => {
  it("converts Databento fixed-point to float", () => {
    expect(priceFromFixed("472600000000")).toBeCloseTo(472.6, 6);
  });

  it("handles zero", () => {
    expect(priceFromFixed("0")).toBe(0);
  });

  it("handles large ES price", () => {
    expect(priceFromFixed("5250250000000")).toBeCloseTo(5250.25, 6);
  });
});

describe("parseNdjsonToBars", () => {
  const ndjson = [
    JSON.stringify({
      hd: { ts_event: "1641038400000000000" },
      open: "472600000000",
      high: "473000000000",
      low: "472500000000",
      close: "472900000000",
      volume: "1234",
    }),
    JSON.stringify({
      hd: { ts_event: "1641038460000000000" },
      open: "472900000000",
      high: "473100000000",
      low: "472800000000",
      close: "473000000000",
      volume: "567",
    }),
    "", // trailing newline — must be ignored
  ].join("\n");

  it("parses records into Bar[]", () => {
    const bars = parseNdjsonToBars(ndjson, "ES.c.0");
    expect(bars).toHaveLength(2);
    expect(bars[0].tsUtc).toBe(BigInt("1641038400000000000"));
    expect(bars[0].open).toBeCloseTo(472.6, 6);
    expect(bars[0].high).toBeCloseTo(473.0, 6);
    expect(bars[0].low).toBeCloseTo(472.5, 6);
    expect(bars[0].close).toBeCloseTo(472.9, 6);
    expect(bars[0].volume).toBe(BigInt(1234));
    expect(bars[0].symbol).toBe("ES.c.0");
  });

  it("stamps symbol from param not response", () => {
    const bars = parseNdjsonToBars(ndjson, "NQ.c.0");
    expect(bars[0].symbol).toBe("NQ.c.0");
  });

  it("ignores empty lines", () => {
    const bars = parseNdjsonToBars("\n\n", "ES.c.0");
    expect(bars).toHaveLength(0);
  });
});

describe("per-year day accounting", () => {
  /**
   * Regression: the fetch loop runs once per year, and plannedDays was
   * measured from the whole requested span, so a 2020-2026 backfill reported
   * 16,968 symbol-days (2,424 x 7) and a $63 cost against a real $9.
   * Clamping to the year window first is what makes the total meaningful.
   */
  it("sums to the requested span, not span x years", () => {
    const from = "2020-01-01";
    const to = "2026-08-20";
    let total = 0;
    for (let year = 2020; year <= 2026; year++) {
      const w = yearWindowUtc(year, from, to);
      total += daysInclusive(w.start.slice(0, 10), w.end.slice(0, 10));
    }
    expect(total).toBe(daysInclusive(from, to));
  });
});

describe("parseAvailableEnd", () => {
  /** Verbatim from a real 422 on 2026-08-20. */
  const body =
    '{"detail":{"case":"dataset_unavailable_range","message":"Part or all of your request for dataset \'GLBX.MDP3\' requires a subscription and/or license to access.","status_code":422,"docs":"https://databento.com/pricing#cme","payload":{"dataset":"GLBX.MDP3","start":"2026-08-20T00:00:00.000000000Z","end":"2026-08-20T23:59:59.000000000Z","available_end":"2026-08-20T20:48:24.524076000Z"}}}';

  it("extracts the embargo boundary so the request can be retried", () => {
    expect(parseAvailableEnd(body)).toBe("2026-08-20T20:48:24.524076000Z");
  });

  it("returns null for other error shapes rather than retrying blindly", () => {
    expect(parseAvailableEnd('{"detail":{"case":"auth_failed"}}')).toBeNull();
    expect(parseAvailableEnd('{"detail":{"case":"dataset_unavailable_range"}}')).toBeNull();
    expect(parseAvailableEnd("not json at all")).toBeNull();
    expect(parseAvailableEnd("")).toBeNull();
  });
});

describe("coverageAgeDays", () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");

  it("is null when coverage is unknown or unparseable", () => {
    expect(coverageAgeDays(null, now)).toBeNull();
    expect(coverageAgeDays("not-a-date", now)).toBeNull();
  });

  it("counts whole days elapsed", () => {
    expect(coverageAgeDays("2026-08-21T00:00:00.000Z", now)).toBe(0);
    expect(coverageAgeDays("2026-08-19T23:59:00.000Z", now)).toBe(1);
    expect(coverageAgeDays("2026-08-14T12:00:00.000Z", now)).toBe(7);
  });
});

describe("formatDiscordMessage", () => {
  const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
    ok: true,
    dryRun: false,
    symbols: [
      { symbol: "MNQ.c.0", year: 2026, status: "ok", newBars: 1380, totalBars: 224998 },
      { symbol: "MES.c.0", year: 2026, status: "skipped", reason: "already current", newBars: 0, totalBars: 223607 },
    ],
    succeeded: 1,
    skipped: 1,
    failed: 0,
    fetchedSymbolDays: 1,
    estimatedCostUsd: 0.0037,
    coverageEndUtc: "2026-08-20T23:59:00.000Z",
    ...over,
  });

  /**
   * Regression from pipeline build #13, which reported "+1,260 bars →
   * 223,532 total" for a symbol whose total was 223,532 before the run. The
   * API returned 1,260 bars and dedup discarded every one of them. Reporting
   * the fetched count makes a stuck refresh look healthy.
   */
  it("reports net bars added, not bars returned by the API", () => {
    const msg = formatDiscordMessage(
      summary({
        symbols: [
          { symbol: "MNQ.c.0", year: 2026, status: "ok", newBars: 1260, addedBars: 8, totalBars: 224878 },
        ],
      }),
      1,
    );
    expect(msg).toContain("+8 bars → 224,878 total");
    expect(msg).not.toContain("1,260 bars →");
  });

  it("says plainly when a fetch added nothing", () => {
    const msg = formatDiscordMessage(
      summary({
        symbols: [
          { symbol: "MGC.v.0", year: 2026, status: "ok", newBars: 1260, addedBars: 0, totalBars: 223532 },
        ],
      }),
      1,
    );
    expect(msg).toContain("no new bars (1,260 fetched, all already cached)");
  });

  it("reports bars added for fetched symbols and status for the rest", () => {
    const msg = formatDiscordMessage(summary(), 1);
    expect(msg).toContain("`MNQ.c.0` +1,380 bars");
    expect(msg).toContain("`MES.c.0` skipped (already current)");
  });

  /**
   * Coverage is reported only when abnormal. A nightly run is legitimately a
   * day behind because of the 24h embargo, and printing that every night is
   * noise that trains the reader to skip the line.
   */
  it("stays silent about coverage when it is current or one day old", () => {
    expect(formatDiscordMessage(summary(), 0)).not.toContain("Coverage");
    expect(formatDiscordMessage(summary(), 1)).not.toContain("Coverage");
  });

  it("warns loudly once coverage falls further behind", () => {
    const msg = formatDiscordMessage(summary(), 5);
    expect(msg).toContain("Coverage only through 2026-08-20T23:59:00.000Z");
    expect(msg).toContain("(5d old)");
  });

  it("says so when coverage is unknown rather than omitting the line", () => {
    const msg = formatDiscordMessage(summary({ coverageEndUtc: null }), null);
    expect(msg).toContain("Coverage unknown");
  });

  it("marks a dry run so an empty result is not mistaken for a failure", () => {
    expect(formatDiscordMessage(summary({ dryRun: true }), 1)).toContain("dry run");
    expect(formatDiscordMessage(summary(), 1)).not.toContain("dry run");
  });

  /**
   * A dry run fetches nothing, so past tense contradicts the run's own
   * footer. Reported from a real Discord message that said "Fetched 4
   * symbol-days" directly above "dry run — nothing fetched".
   */
  it("uses future tense throughout on a dry run", () => {
    const msg = formatDiscordMessage(
      summary({
        dryRun: true,
        symbols: [
          { symbol: "MGC.c.0", year: 2026, status: "ok", newBars: 0, totalBars: 120886, fromDate: "2026-08-19", toDate: "2026-08-20" },
        ],
      }),
      1,
    );
    expect(msg).toContain("would fetch 2026-08-19 → 2026-08-20");
    expect(msg.toLowerCase()).not.toContain("fetched 2026");
    expect(msg).toContain("nothing was fetched and nothing was written");
  });

  /**
   * The symbol-day count was dropped from the message: it read as a symbol
   * count, and the per-symbol lines already carry the dates it summarised.
   */
  it("does not restate the symbol-day count", () => {
    const msg = formatDiscordMessage(summary({ fetchedSymbolDays: 4 }), 1);
    expect(msg).not.toContain("symbol-day");
    expect(msg).toContain("Estimated cost: $0.00");
  });
});

describe("lastBarIso", () => {
  const bar = (iso: string) => ({
    tsUtc: BigInt(Date.parse(iso)) * BigInt(1_000_000),
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: BigInt(1),
    symbol: "MNQ.c.0",
  });

  it("returns undefined for an empty set", () => {
    expect(lastBarIso([])).toBeUndefined();
  });

  it("returns the newest bar regardless of input order", () => {
    const bars = [bar("2026-08-19T12:00:00.000Z"), bar("2026-08-19T23:59:00.000Z"), bar("2026-08-01T00:00:00.000Z")];
    expect(lastBarIso(bars)).toBe("2026-08-19T23:59:00.000Z");
  });
});

describe("coverageEndUtc", () => {
  const result = (symbol: string, lastBarUtc?: string) => ({
    symbol,
    year: 2026,
    status: "ok" as const,
    newBars: 0,
    totalBars: 0,
    lastBarUtc,
  });

  it("is null when nothing reported a last bar", () => {
    expect(coverageEndUtc([result("MNQ.c.0"), result("MES.c.0")])).toBeNull();
  });

  /**
   * The chain is only as current as its most stale symbol — reporting the
   * newest would hide exactly the symbol that stopped refreshing.
   */
  it("returns the OLDEST last bar across symbols", () => {
    const results = [
      result("MNQ.c.0", "2026-08-19T23:59:00.000Z"),
      result("MGC.c.0", "2026-08-14T20:00:00.000Z"),
      result("MES.c.0", "2026-08-19T23:59:00.000Z"),
    ];
    expect(coverageEndUtc(results)).toBe("2026-08-14T20:00:00.000Z");
  });

  /** Build #60 (2026-10-20): an MGC.v.0 backfill 2019 → now failed as "2484d old" on its 2019 file. */
  it("takes each symbol's newest year, so a multi-year backfill is not judged by its first year", () => {
    const results = [
      { ...result("MGC.v.0", "2019-12-31T21:59:00.000Z"), year: 2019 },
      { ...result("MGC.v.0", "2025-12-31T21:59:00.000Z"), year: 2025 },
      result("MGC.v.0", "2026-10-19T20:59:00.000Z"),
      result("MNQ.c.0", "2026-10-18T20:59:00.000Z"),
    ];
    expect(coverageEndUtc(results)).toBe("2026-10-18T20:59:00.000Z");
  });

  it("ignores symbols with no last bar rather than treating them as current", () => {
    const results = [result("MNQ.c.0", "2026-08-19T23:59:00.000Z"), result("MES.c.0")];
    expect(coverageEndUtc(results)).toBe("2026-08-19T23:59:00.000Z");
  });
});

describe("daysInclusive", () => {
  it("counts both endpoints", () => {
    expect(daysInclusive("2026-08-01", "2026-08-01")).toBe(1);
    expect(daysInclusive("2026-08-01", "2026-08-02")).toBe(2);
  });

  it("spans months and years", () => {
    expect(daysInclusive("2026-05-19", "2026-08-19")).toBe(93);
    expect(daysInclusive("2025-12-31", "2026-01-01")).toBe(2);
  });

  it("returns 0 for an inverted or unparseable range", () => {
    expect(daysInclusive("2026-08-02", "2026-08-01")).toBe(0);
    expect(daysInclusive("nonsense", "2026-08-01")).toBe(0);
  });
});

describe("estimateCostUsd", () => {
  it("is positive for any symbols/days", () => {
    expect(estimateCostUsd(1, 1)).toBeGreaterThan(0);
  });

  it("is proportional to symbol count and day count", () => {
    const base = estimateCostUsd(1, 1);
    expect(estimateCostUsd(2, 1)).toBeCloseTo(base * 2, 6);
    expect(estimateCostUsd(1, 3)).toBeCloseTo(base * 3, 6);
  });

  it("prorates by day rather than rounding up to whole years", () => {
    // A quarter-year must cost about a quarter of a year, not a full one.
    const quarter = estimateCostUsd(1, 91);
    const full = estimateCostUsd(1, 365);
    expect(quarter).toBeCloseTo(full * (91 / 365), 6);
  });

  /**
   * Calibration guard. Real billing on 2026-08-20: MNQ + MES over
   * 2026-05-19..2026-08-19 transferred 10.2 MB and cost $0.67. The estimate
   * should land in the same ballpark — the pre-2026-08 model said $6.29.
   */
  it("matches observed billing for the 2026-08-20 MNQ+MES backfill", () => {
    const cost = estimateCostUsd(2, daysInclusive("2026-05-19", "2026-08-19"));
    expect(cost).toBeGreaterThan(0.4);
    expect(cost).toBeLessThan(1.2);
  });

  it("6 symbols × 1 year is in expected range ($5-$15)", () => {
    const cost = estimateCostUsd(6, 365);
    expect(cost).toBeGreaterThan(5);
    expect(cost).toBeLessThan(15);
  });
});

describe("parseArgs", () => {
  it("parses required args", () => {
    const args = parseArgs(["--symbols", "ES.c.0,NQ.c.0", "--from", "2022-01-01", "--to", "2024-12-31"]);
    expect(args.symbols).toEqual(["ES.c.0", "NQ.c.0"]);
    expect(args.fromDate).toBe("2022-01-01");
    expect(args.toDate).toBe("2024-12-31");
    expect(args.fromYear).toBe(2022);
    expect(args.toYear).toBe(2024);
    expect(args.confirm).toBe(false);
    expect(args.dryRun).toBe(false);
    expect(args.force).toBe(false);
  });

  it("parses flags", () => {
    const args = parseArgs([
      "--symbols", "ES.c.0",
      "--from", "2022-01-01",
      "--to", "2022-12-31",
      "--confirm",
      "--dry-run",
      "--force",
    ]);
    expect(args.confirm).toBe(true);
    expect(args.dryRun).toBe(true);
    expect(args.force).toBe(true);
  });

  it("throws when --symbols is missing", () => {
    expect(() => parseArgs(["--from", "2022-01-01", "--to", "2022-12-31"])).toThrow("--symbols");
  });

  it("throws when --from is missing", () => {
    expect(() => parseArgs(["--symbols", "ES.c.0", "--to", "2022-12-31"])).toThrow("--from");
  });

  it("throws when --to is before --from", () => {
    expect(() =>
      parseArgs(["--symbols", "ES.c.0", "--from", "2024-01-01", "--to", "2022-12-31"])
    ).toThrow();
  });
});

describe("shouldSkipYear", () => {
  const currentYear = new Date().getUTCFullYear();

  it("skips existing past-year file without --force", () => {
    const result = shouldSkipYear("/fake/2022.parquet", 2022, currentYear, false, false, () => true);
    expect(result.skip).toBe(true);
  });

  it("does not skip missing file", () => {
    const result = shouldSkipYear("/fake/2022.parquet", 2022, currentYear, false, false, () => false);
    expect(result.skip).toBe(false);
  });

  it("does not skip current year even if file exists", () => {
    const result = shouldSkipYear("/fake/cur.parquet", currentYear, currentYear, false, false, () => true);
    expect(result.skip).toBe(false);
  });

  it("does not skip with --force even if file exists", () => {
    const result = shouldSkipYear("/fake/2022.parquet", 2022, currentYear, true, false, () => true);
    expect(result.skip).toBe(false);
  });

  it("does not skip existing file in --append mode (tail check)", () => {
    const result = shouldSkipYear("/fake/2022.parquet", 2022, currentYear, false, true, () => true);
    expect(result.skip).toBe(false);
    expect(result.reason).toBe("append-mode tail check");
  });
});

describe("yearWindowUtc", () => {
  it("clips start date to year start for inner years", () => {
    const { start } = yearWindowUtc(2023, "2022-06-01", "2024-03-31");
    expect(start).toBe("2023-01-01T00:00:00");
  });

  it("clips end date to year end for inner years", () => {
    const { end } = yearWindowUtc(2023, "2022-06-01", "2024-03-31");
    expect(end).toBe("2023-12-31T23:59:59");
  });

  it("uses fromDate for the boundary start year", () => {
    const { start } = yearWindowUtc(2022, "2022-06-01", "2024-03-31");
    expect(start).toBe("2022-06-01T00:00:00");
  });

  it("uses toDate for the boundary end year", () => {
    const { end } = yearWindowUtc(2024, "2022-06-01", "2024-03-31");
    expect(end).toBe("2024-03-31T23:59:59");
  });
});
