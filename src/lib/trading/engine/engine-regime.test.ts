/**
 * The nightly job and the lazy fill, against an in-memory `regime_days` with
 * the shipped migration replayed.
 *
 * The properties worth the file are the ones invisible everywhere else: the
 * pass fires inside the CME break and nowhere else, the target session is the
 * one about to open (Monday's, on a Friday evening), a partial row for the
 * session being labelled is never read, the lazy path neither awaits nor
 * re-fires per bar, a fetch that throws still leaves a row and a Discord
 * field, retries are bounded, and one fill at a time holds across both paths.
 *
 * And since A81: the warmup comes off the archive, a bound the archive
 * cannot move is answered once and never retried, and a bound that can move
 * still gets the budget.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
}));

let db: InstanceType<typeof Database>;

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
}));

import type { BarData } from "@/lib/brokers/types";
import type { ArchiveBarsOutcome } from "@/lib/data/cached-bars";
import type { TickerSymbol } from "@/lib/trading/domain";
import { getRegimeDay } from "@/lib/db/regime-days";
import {
  CLASSIFIER_MIN_SESSION_DAYS,
  CLASSIFIER_WARMUP_SESSION_DAYS,
} from "@/lib/trading/regime/classify-regime";
import {
  LAZY_RETRY_MS,
  MAX_LAZY_FILL_ATTEMPTS,
  RegimeLabelController,
  isInsideNightlyWindow,
  nextSessionDate,
  type ArchiveRead,
  type RegimeLabelDeps,
} from "./engine-regime";

/**
 * A synthetic Globex series inside MNQ's 09:30–16:00 window, on `count`
 * consecutive weekdays ending the session day before `endExclusive`. The day's
 * range widens with `spread` so the classifier has something other than a
 * constant series to rank.
 *
 * **Thinned to one bar every five minutes on purpose.** `buildSessionDays`
 * reduces the window to a high, a low and a close, so the bar spacing changes
 * nothing it reads — and a true 1m fixture over the classifier's 275-session
 * warmup is 125,000 objects per test.
 */
function series(endExclusive: string, count: number, spread: (i: number) => number): BarData[] {
  const bars: BarData[] = [];
  const cursor = new Date(`${endExclusive}T00:00:00Z`);
  const days: string[] = [];
  while (days.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    days.push(cursor.toISOString().slice(0, 10));
  }
  days.reverse();

  days.forEach((day, i) => {
    const width = spread(i);
    // 13:30Z–20:00Z is 09:30–16:00 ET during EDT; every fixture date below is
    // inside daylight time, which is what keeps the window arithmetic honest.
    for (let minute = 0; minute < 390; minute += 5) {
      const at = new Date(`${day}T13:30:00Z`);
      at.setUTCMinutes(at.getUTCMinutes() + minute);
      const base = 20_000 + i;
      bars.push({
        timestamp: at.toISOString(),
        open: base,
        high: base + width,
        low: base - width,
        close: base,
        volume: 1,
      });
    }
  });
  return bars;
}

/** A full archive: coverage reaching back past anything a fixture asks for. */
function served(bars: BarData[]): ArchiveBarsOutcome {
  return {
    kind: "bars",
    bars,
    coverage: { minUtc: new Date("2000-01-01T00:00:00Z"), maxUtc: new Date("2026-09-05T21:00:00Z") },
  };
}

interface Harness {
  controller: RegimeLabelController;
  reads: ArchiveRead[];
  events: Array<{ event: string; message: string }>;
  announced: Array<{ sessionDate: string; labels: string[] }>;
  setBars: (bars: BarData[]) => void;
  setOutcome: (outcome: ArchiveBarsOutcome) => void;
  setNow: (at: Date) => void;
}

function harness(over: Partial<RegimeLabelDeps> = {}): Harness {
  const reads: ArchiveRead[] = [];
  const events: Array<{ event: string; message: string }> = [];
  const announced: Array<{ sessionDate: string; labels: string[] }> = [];
  let outcome: ArchiveBarsOutcome = served([]);
  let now = new Date("2026-09-04T21:10:00Z");

  const deps = {
    tickers: () => ["/MNQ" as TickerSymbol],
    readArchiveBars: async (read: ArchiveRead) => {
      reads.push(read);
      return outcome;
    },
    logEvent: (event: string, message: string) => {
      events.push({ event, message });
    },
    log: () => {},
    announce: async (sessionDate: string, labels: readonly { ticker: string; result: { label: string } }[]) => {
      announced.push({ sessionDate, labels: labels.map((l) => `${l.ticker} ${l.result.label}`) });
    },
    now: () => now,
    ...over,
  } satisfies RegimeLabelDeps;

  return {
    controller: new RegimeLabelController(deps),
    reads,
    events,
    announced,
    setBars: (next) => {
      outcome = served(next);
    },
    setOutcome: (next) => {
      outcome = next;
    },
    setNow: (at) => {
      now = at;
    },
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the nightly window", () => {
  // 21:10Z is 17:10 ET during EDT; 20:50Z is 16:50 ET, before the break.
  it("is open five past the hour and closed on either side of the break", () => {
    expect(isInsideNightlyWindow(new Date("2026-09-04T21:10:00Z"))).toBe(true);
    expect(isInsideNightlyWindow(new Date("2026-09-04T20:50:00Z"))).toBe(false);
    expect(isInsideNightlyWindow(new Date("2026-09-04T21:02:00Z"))).toBe(false);
    expect(isInsideNightlyWindow(new Date("2026-09-04T22:05:00Z"))).toBe(false);
  });

  it("labels Monday's session from Friday's break", () => {
    // 2026-09-04 is a Friday; 17:10 ET on it opens 2026-09-07's session.
    expect(nextSessionDate(new Date("2026-09-04T21:10:00Z"))).toBe("2026-09-07");
    expect(nextSessionDate(new Date("2026-09-03T21:10:00Z"))).toBe("2026-09-04");
  });
});

describe("RegimeLabelController.runNightlyPass", () => {
  it("does nothing outside the break", async () => {
    const h = harness();
    h.setNow(new Date("2026-09-04T18:00:00Z"));
    await h.controller.runNightlyPass();
    expect(h.reads).toHaveLength(0);
  });

  it("labels the next session, writes it, and announces it once per break", async () => {
    const h = harness();
    h.setBars(series("2026-09-05", 320, (i) => 40 + (i % 7)));

    await h.controller.runNightlyPass();
    await h.controller.runNightlyPass();

    expect(h.reads).toHaveLength(1);
    const row = getRegimeDay("MNQ", "2026-09-07", "1");
    expect(row?.label).not.toBe("unknown");
    expect(row?.source).toBe("nightly");
    expect(h.announced).toEqual([
      { sessionDate: "2026-09-07", labels: [`/MNQ ${row?.label}`] },
    ]);
  });

  it("still labels the session when the first pass of the break found nothing deployed", async () => {
    // A leg activated at 17:40 has to get tonight's label. Marking the
    // session done on an empty pass would leave it unlabelled until the lazy
    // fill reached it on tomorrow's first bar.
    let tickers: TickerSymbol[] = [];
    const h = harness({ tickers: () => tickers });
    h.setBars(series("2026-09-05", 320, (i) => 40 + (i % 7)));

    await h.controller.runNightlyPass();
    expect(h.reads).toHaveLength(0);

    tickers = ["/MNQ" as TickerSymbol];
    await h.controller.runNightlyPass();

    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.source).toBe("nightly");
  });

  it("reads the archive symbol's own 1m bars back past the classifier's whole warmup", async () => {
    const h = harness();
    h.setBars(series("2026-09-05", 320, () => 40));
    await h.controller.runNightlyPass();

    const [read] = h.reads;
    expect(read.cacheSymbol).toBe("MNQ.v.0");
    const spanDays = (read.to.getTime() - read.from.getTime()) / 86_400_000;
    expect(spanDays).toBeGreaterThan(CLASSIFIER_WARMUP_SESSION_DAYS);
  });

  it("writes unknown and says why when the archive covers the window but comes up short of the baseline", async () => {
    const h = harness();
    h.setBars(series("2026-09-05", 40, () => 40));

    await h.controller.runNightlyPass();

    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).toBe("unknown");
    const failed = h.events.find((e) => e.event === "regime_label_failed");
    // The count is quoted against the classifier's cliff, never against the
    // window the fetch is sized with: an operator reading "262 of 275" would
    // conclude the archive is short when 262 would have labelled.
    expect(failed?.message).toContain(`${CLASSIFIER_MIN_SESSION_DAYS} needed for a label`);
    expect(failed?.message).not.toContain(`${CLASSIFIER_WARMUP_SESSION_DAYS} needed`);
    // A short window is the transient bound: the newest row it did read is
    // what says whether the archive is thin or merely stale.
    expect(failed?.message).toContain("newest is 2026-09-04");
  });

  it("leaves the other instruments labelled when one throws, and names the thrower unknown", async () => {
    // The failure path has to leave a row and a field: an instrument absent
    // from the line is the one an operator reads as fine.
    const bars = series("2026-09-05", 320, (i) => 40 + (i % 7));
    const h = harness({
      tickers: () => ["/MES", "/MNQ"] as TickerSymbol[],
      readArchiveBars: async (read) => {
        if (read.cacheSymbol === "MES.v.0") throw new Error("parquet read failed");
        return served(bars);
      },
    });
    h.setBars(bars);

    await h.controller.runNightlyPass();

    expect(getRegimeDay("MES", "2026-09-07", "1")?.label).toBe("unknown");
    expect(getRegimeDay("MES", "2026-09-07", "1")?.features).toBeNull();
    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).not.toBe("unknown");
    expect(h.announced[0].labels).toContain("/MES unknown");
    expect(h.announced[0].labels).toHaveLength(2);
  });

  it("heals a thrown unknown on a later pass rather than refusing to overwrite it", async () => {
    let readThrows = true;
    const bars = series("2026-09-05", 320, (i) => 40 + (i % 7));
    const h = harness({
      readArchiveBars: async () => {
        if (readThrows) throw new Error("parquet read failed");
        return served(bars);
      },
    });
    h.setBars(bars);

    await h.controller.runNightlyPass();
    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).toBe("unknown");

    readThrows = false;
    h.controller.noteBar("/MNQ" as TickerSymbol, "2026-09-06T22:05:00Z");
    await vi.waitFor(() =>
      expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).not.toBe("unknown"),
    );
  });

  it("does not read the session it is labelling, so a partial day cannot move the label", async () => {
    const complete = series("2026-09-05", 320, (i) => 40 + (i % 7));
    const before = harness();
    before.setBars(complete);
    await before.controller.runNightlyPass();
    const withoutTarget = getRegimeDay("MNQ", "2026-09-07", "1")?.label;

    db = new Database(":memory:");
    for (const fn of migrations) fn(db);

    // The same history plus a wildly wide partial session on the target day.
    const after = harness();
    after.setBars([...complete, ...series("2026-09-08", 1, () => 5_000)]);
    await after.controller.runNightlyPass();

    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).toBe(withoutTarget);
  });
});

describe("RegimeLabelController.noteBar", () => {
  /** 18:05 ET on Sunday 2026-09-06 — the Globex open, and the first bar of
   *  the 2026-09-07 session day. */
  const FIRST_BAR = "2026-09-06T22:05:00Z";

  it("returns synchronously and fills the session day off the tick", async () => {
    const h = harness();
    h.setBars(series("2026-09-05", 320, (i) => 40 + (i % 7)));

    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    expect(getRegimeDay("MNQ", "2026-09-07", "1")).toBeNull();

    await vi.waitFor(() => expect(getRegimeDay("MNQ", "2026-09-07", "1")).not.toBeNull());
    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.source).toBe("lazy");
  });

  it("reads bars once for a session day however many bars arrive", async () => {
    const h = harness();
    h.setBars(series("2026-09-05", 320, (i) => 40 + (i % 7)));

    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    await vi.waitFor(() => expect(getRegimeDay("MNQ", "2026-09-07", "1")).not.toBeNull());
    for (let i = 0; i < 20; i++) h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);

    expect(h.reads).toHaveLength(1);
  });

  it("backs off rather than retrying a failed fill on every bar", async () => {
    const h = harness();
    h.setBars(series("2026-09-05", 40, () => 40));

    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    await vi.waitFor(() => expect(getRegimeDay("MNQ", "2026-09-07", "1")).not.toBeNull());
    // One read per fill, always: the archive's extent is asked and answered
    // inside the read, so there is no widened second one to make.
    expect(h.reads).toHaveLength(1);

    for (let i = 0; i < 20; i++) h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    expect(h.reads).toHaveLength(1);

    h.setNow(new Date(Date.parse(FIRST_BAR) + LAZY_RETRY_MS + 1));
    h.setBars(series("2026-09-05", 320, (i) => 40 + (i % 7)));
    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);

    await vi.waitFor(() => expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).not.toBe("unknown"));
    expect(h.reads).toHaveLength(2);
  });

  it("stops asking after the attempt budget on a session the archive answers short", async () => {
    // A window the archive covers and cannot fill is the *transient* bound —
    // a mid-refresh read or a thin stretch — so it keeps the budget. Without
    // one, `settled` is only set on a real label and that is ~92 attempts
    // across a Globex day.
    const h = harness();
    h.setBars(series("2026-09-05", 40, () => 40));

    let at = Date.parse(FIRST_BAR);
    for (let i = 1; i <= MAX_LAZY_FILL_ATTEMPTS; i++) {
      h.setNow(new Date(at));
      h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
      await vi.waitFor(() => expect(h.reads).toHaveLength(i));
      // The read is recorded before the fill settles, and a fill still in
      // flight defers the next bar rather than spending an attempt.
      await new Promise((resolve) => setTimeout(resolve, 0));
      at += LAZY_RETRY_MS + 1;
    }

    await vi.waitFor(() =>
      expect(h.events.filter((e) => e.message.includes("gave up"))).toHaveLength(1),
    );

    h.setNow(new Date(at));
    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    at += LAZY_RETRY_MS + 1;
    h.setNow(new Date(at));
    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);

    expect(h.reads).toHaveLength(MAX_LAZY_FILL_ATTEMPTS);
    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).toBe("unknown");
  });

  it("defers a second ticker's fill rather than reading two archives at once", async () => {
    const seen: ArchiveRead[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bars = series("2026-09-05", 320, (i) => 40 + (i % 7));
    const h = harness({
      readArchiveBars: async (read) => {
        seen.push(read);
        await gate;
        return served(bars);
      },
    });

    // A restart mid-session evaluates every managed instrument's first bar in
    // the same second.
    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    h.controller.noteBar("/MES" as TickerSymbol, FIRST_BAR);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(getRegimeDay("MNQ", "2026-09-07", "1")).not.toBeNull());
    // Deferred, not queued, and not backed off either: the next bar it
    // evaluates is its turn.
    expect(getRegimeDay("MES", "2026-09-07", "1")).toBeNull();
    h.controller.noteBar("/MES" as TickerSymbol, FIRST_BAR);
    await vi.waitFor(() => expect(getRegimeDay("MES", "2026-09-07", "1")).not.toBeNull());
  });

  it("defers the nightly pass while a lazy fill holds the box, without marking the session done", async () => {
    const seen: ArchiveRead[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bars = series("2026-09-05", 320, (i) => 40 + (i % 7));
    const h = harness({
      readArchiveBars: async (read) => {
        seen.push(read);
        await gate;
        return served(bars);
      },
    });

    // 17:10 ET on Friday the 4th targets the same 2026-09-07 session the bar
    // above belongs to — the nightly-still-running overlap, from the other side.
    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await h.controller.runNightlyPass();
    expect(seen).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(getRegimeDay("MNQ", "2026-09-07", "1")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));

    await h.controller.runNightlyPass();
    expect(seen).toHaveLength(2);
    expect(h.announced).toHaveLength(1);
  });

  it("names the cause when the archive read throws, rather than only the attempt count", async () => {
    // A torn Parquet mid-refresh or an ENOENT on a remounted NAS reaches no
    // other line: `fill` reports the bounds it was *given*. Without this the
    // failure surfaces as "gave up after 3 attempts" — a count with no cause,
    // which is the defect class A81 was filed as.
    const h = harness({
      readArchiveBars: async () => {
        throw new Error("parquet footer is truncated");
      },
    });

    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    await vi.waitFor(() =>
      expect(h.events.some((e) => e.message.includes("parquet footer is truncated"))).toBe(true),
    );
    // The lazy path writes no row, unlike the nightly pass: the session is
    // unlabelled rather than labelled unknown, which is what a trade in it
    // records.
    expect(getRegimeDay("MNQ", "2026-09-07", "1")).toBeNull();
  });

  it("swallows a bar timestamp it cannot bucket rather than failing the tick", () => {
    const h = harness();
    expect(() => h.controller.noteBar("/MNQ" as TickerSymbol, "not-a-timestamp")).not.toThrow();
    expect(h.reads).toHaveLength(0);
  });

  it("ignores a ticker the contract table has no day session for", () => {
    const h = harness();
    h.controller.noteBar("/ES" as TickerSymbol, FIRST_BAR);
    expect(h.reads).toHaveLength(0);
  });
});

/**
 * A81. The labeller read its 275-session warmup through a broker that holds
 * about a month, so the read came back truncated, the extension guard tested
 * *our* limit rather than the provider's and asked again for the identical
 * set, and no session was ever labelled.
 */
describe("the warmup comes off the archive", () => {
  const FIRST_BAR = "2026-09-06T22:05:00Z";

  const TRUNCATED: ArchiveBarsOutcome = {
    kind: "unavailable",
    bound: "coverage-short",
    detail: "MNQ.c.0 starts 2026-08-05T00:00:00.000Z, after the 2025-07-14T22:00:00.000Z the window needs",
  };

  it("answers unknown, names the bound, and does not read again when the archive stops a month short", async () => {
    const h = harness();
    h.setOutcome(TRUNCATED);

    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    await vi.waitFor(() => expect(getRegimeDay("MNQ", "2026-09-07", "1")).not.toBeNull());

    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).toBe("unknown");
    const failed = h.events.filter((e) => e.event === "regime_label_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].message).toContain("coverage-short");
    expect(failed[0].message).toContain("MNQ.c.0 starts 2026-08-05");

    // The bound cannot move while the process runs, so the budget is not
    // spent on it and nothing is said a second time.
    let at = Date.parse(FIRST_BAR);
    for (let i = 0; i < MAX_LAZY_FILL_ATTEMPTS + 2; i++) {
      at += LAZY_RETRY_MS + 1;
      h.setNow(new Date(at));
      h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    }
    expect(h.reads).toHaveLength(1);
    expect(h.events.filter((e) => e.event === "regime_label_failed")).toHaveLength(1);
  });

  it("labels the same session off a cache that covers the warmup", async () => {
    const h = harness();
    h.setBars(series("2026-09-05", 320, (i) => 40 + (i % 7)));

    h.controller.noteBar("/MNQ" as TickerSymbol, FIRST_BAR);
    await vi.waitFor(() => expect(getRegimeDay("MNQ", "2026-09-07", "1")).not.toBeNull());

    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).not.toBe("unknown");
    expect(h.events.filter((e) => e.event === "regime_label_failed")).toHaveLength(0);
    expect(h.reads).toHaveLength(1);
  });

  const NOT_MOUNTED: ArchiveBarsOutcome = {
    kind: "unavailable",
    bound: "not-mounted",
    detail: "no bar cache directory at /app/data/bar-cache in this process",
  };

  /** 10:00 ET and 18:05 ET on Friday 2026-09-04: two session days (09-04 and
   *  09-05, since `sessionDateOf` rolls at 17:00) inside one ET date. */
  const MORNING_BAR = "2026-09-04T14:00:00Z";
  const EVENING_BAR = "2026-09-04T22:05:00Z";

  async function fillFor(h: ReturnType<typeof harness>, at: string, bar: string, session: string) {
    h.setNow(new Date(at));
    h.controller.noteBar("/MNQ" as TickerSymbol, bar);
    await vi.waitFor(() => expect(getRegimeDay("MNQ", session, "1")).not.toBeNull());
    // Let the fill's `finally` release the box before the next one is asked.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("says a permanent bound once a day, not once per session", async () => {
    const h = harness();
    h.setOutcome(NOT_MOUNTED);

    await fillFor(h, "2026-09-04T14:05:00Z", MORNING_BAR, "2026-09-04");
    await fillFor(h, "2026-09-04T22:10:00Z", EVENING_BAR, "2026-09-05");

    expect(getRegimeDay("MNQ", "2026-09-04", "1")?.label).toBe("unknown");
    expect(getRegimeDay("MNQ", "2026-09-05", "1")?.label).toBe("unknown");
    expect(h.events.filter((e) => e.event === "regime_label_failed")).toHaveLength(1);
  });

  it("says it again the next ET day, rather than once for the life of the process", async () => {
    // The box runs `--restart unless-stopped` for weeks. A bound announced
    // once per process is a condition an operator can only find by scrolling
    // back to the restart; `calendarReportedOn`'s shape is a line a day.
    const h = harness();
    h.setOutcome(NOT_MOUNTED);

    // 17:10 ET Friday labels Monday; 17:10 ET Monday labels Tuesday.
    await h.controller.runNightlyPass();
    h.setNow(new Date("2026-09-07T21:10:00Z"));
    await h.controller.runNightlyPass();

    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).toBe("unknown");
    expect(getRegimeDay("MNQ", "2026-09-08", "1")?.label).toBe("unknown");
    expect(h.events.filter((e) => e.event === "regime_label_failed")).toHaveLength(2);
  });

  it("says it again inside the same day once the bound has changed", async () => {
    const h = harness();
    h.setOutcome(NOT_MOUNTED);
    await fillFor(h, "2026-09-04T14:05:00Z", MORNING_BAR, "2026-09-04");

    h.setOutcome({ kind: "unavailable", bound: "no-coverage", detail: "nothing for MNQ.c.0" });
    await fillFor(h, "2026-09-04T22:10:00Z", EVENING_BAR, "2026-09-05");

    const failed = h.events.filter((e) => e.event === "regime_label_failed");
    expect(failed).toHaveLength(2);
    expect(failed[1].message).toContain("no-coverage");
  });
});

/**
 * The transient lane, which a permanently thin archive otherwise lives in
 * forever: the coverage predicate is min-side only and `BarSourceCoverage` is
 * an extent, so a symbol with an interior hole — the state of a cache being
 * rebuilt after a storage loss — clears `coverage-short` and lands
 * here every session.
 */
describe("a shortfall the archive is not blamed for is throttled on its answer", () => {
  it("says a miss that did not come out differently once, across sessions", async () => {
    const h = harness();
    h.setBars(series("2026-09-05", 40, () => 40));

    await h.controller.runNightlyPass();
    h.setNow(new Date("2026-09-07T21:10:00Z"));
    await h.controller.runNightlyPass();

    expect(getRegimeDay("MNQ", "2026-09-07", "1")?.label).toBe("unknown");
    expect(getRegimeDay("MNQ", "2026-09-08", "1")?.label).toBe("unknown");
    expect(h.events.filter((e) => e.event === "regime_label_failed")).toHaveLength(1);
  });

  it("says it again once a refresh has added rows", async () => {
    const h = harness();
    h.setBars(series("2026-09-05", 40, () => 40));
    await h.controller.runNightlyPass();

    h.setBars(series("2026-09-08", 45, () => 40));
    h.setNow(new Date("2026-09-07T21:10:00Z"));
    await h.controller.runNightlyPass();

    const failed = h.events.filter((e) => e.event === "regime_label_failed");
    expect(failed).toHaveLength(2);
    expect(failed[1].message).toContain("newest is 2026-09-07");
  });
});
