import { describe, it, expect, beforeEach } from "vitest";
import { burstKeyFor, observeBurst, resetBursts } from "./burst";

const T0 = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  resetBursts();
});

describe("burstKeyFor", () => {
  it("puts the event in the key without letting it replace the message", () => {
    // An event names a *kind* of thing, not an instance. Two lines under one
    // event naming two order ids are two incidents, and keying on the event
    // alone folded the second into the first — where it reached no row, no
    // ring and no console.
    const a = burstKeyFor("bracket_cancel_failed", "d1", null, "Cancel bracket #8001 failed");
    const b = burstKeyFor("bracket_cancel_failed", "d1", null, "Cancel bracket #8002 failed");
    const same = burstKeyFor("bracket_cancel_failed", "d1", null, "Cancel bracket #8001 failed");
    expect(a).not.toBe(b);
    expect(a).toBe(same);
  });

  it("keeps two events apart even when they render the same sentence", () => {
    const a = burstKeyFor("entry_blocked", "d1", null, "same text");
    const b = burstKeyFor("entry_skipped", "d1", null, "same text");
    expect(a).not.toBe(b);
  });

  it("keys on the message when the line has no event", () => {
    const a = burstKeyFor(null, "d1", null, "same text");
    const b = burstKeyFor(null, "d1", null, "same text");
    const c = burstKeyFor(null, "d1", null, "different text");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  // The burst this exists for is `account <id>: fill orderId=<id> not in
  // tradovate_order_map — dropping` (tradovate/realtime.ts:748). Every one
  // of the ~23 lines carries two different ids, so a key over the raw text
  // collapses nothing at all — which is why that site, and only that site,
  // hands the pipe a `burstKey`.
  it("collapses long digit runs for a line whose call site named a burstKey", () => {
    // The production shape is both axes at once — the site names
    // `orphan_fill_dropped` *and* hands over the `orphan_fill` hint — so
    // that is what these carry. It is the only composition of the two in
    // the tree, and a bare-event or bare-key version of this test would
    // exercise a call shape nothing makes.
    const a = burstKeyFor("orphan_fill_dropped", "d1", "orphan_fill", "account 11444469: fill orderId=8811001 not in map");
    const b = burstKeyFor("orphan_fill_dropped", "d1", "orphan_fill", "account 11447788: fill orderId=8811002 not in map");
    expect(a).toBe(b);
  });

  it("does not let the burstKey fold two different events together", () => {
    const a = burstKeyFor("orphan_fill_dropped", "d1", "orphan_fill", "account 11444469: fill orderId=8811001 not in map");
    const b = burstKeyFor("fill_fee_missing", "d1", "orphan_fill", "account 11444469: fill orderId=8811001 not in map");
    expect(a).not.toBe(b);
  });

  // Normalisation is opt-in, and this is the reason. Applied to every line
  // it erased ids call sites deliberately carry — two accounts re-routing
  // in one refresh, N accounts failing one flatten-all, a second stranded
  // trade — and a folded repeat reaches no surface at all, so the second
  // incident was not merely counted, it was silent.
  it("keeps two ids apart on a bare line — two ids are two incidents", () => {
    const a = burstKeyFor(null, "d1", null, "account 11444469: fill orderId=8811001 not in map");
    const b = burstKeyFor(null, "d1", null, "account 11447788: fill orderId=8811002 not in map");
    expect(a).not.toBe(b);
  });

  it("still folds a bare line that repeats byte for byte", () => {
    const a = burstKeyFor(null, "d1", null, "no bars for /NQ in the last 90s");
    const b = burstKeyFor(null, "d1", null, "no bars for /NQ in the last 90s");
    expect(a).toBe(b);
  });

  it("leaves a short number alone, so a size or a tick count still discriminates", () => {
    const a = burstKeyFor(null, "d1", null, "closed 1 contract");
    const b = burstKeyFor(null, "d1", null, "closed 4 contracts");
    expect(a).not.toBe(b);
  });

  it("separates deployments and separates named causes", () => {
    expect(burstKeyFor(null, "d1", null, "x")).not.toBe(burstKeyFor(null, "d2", null, "x"));
    expect(burstKeyFor(null, "d1", "sl", "x")).not.toBe(burstKeyFor(null, "d1", "tp", "x"));
  });
});

describe("observeBurst", () => {
  it("opens a window on the first emission", () => {
    expect(observeBurst("k", iso(T0), T0)).toEqual({ first: true });
  });

  it("counts repeats inside the window and names the row they belong to", () => {
    observeBurst("k", iso(T0), T0);
    expect(observeBurst("k", iso(T0 + 1_000), T0 + 1_000)).toEqual({
      first: false,
      firstTimestamp: iso(T0),
      count: 2,
    });
    expect(observeBurst("k", iso(T0 + 2_000), T0 + 2_000)).toMatchObject({ count: 3 });
  });

  it("counts 23 identical emissions as one row and a count of 23", () => {
    let opened = 0;
    let last = 0;
    for (let i = 0; i < 23; i++) {
      const out = observeBurst("k", iso(T0 + i), T0 + i);
      if (out.first) opened++;
      else last = out.count;
    }
    expect(opened).toBe(1);
    expect(last).toBe(23);
  });

  it("opens a fresh window once the old one has expired", () => {
    observeBurst("k", iso(T0), T0);
    expect(observeBurst("k", iso(T0 + 29_999), T0 + 29_999)).toMatchObject({ first: false });
    expect(observeBurst("k", iso(T0 + 30_000), T0 + 30_000)).toEqual({ first: true });
  });

  it("counts each key independently", () => {
    observeBurst("a", iso(T0), T0);
    observeBurst("b", iso(T0), T0);
    expect(observeBurst("a", iso(T0 + 1), T0 + 1)).toMatchObject({ count: 2 });
    expect(observeBurst("b", iso(T0 + 1), T0 + 1)).toMatchObject({ count: 2 });
  });

  it("stays bounded when a 24/7 process throws unbounded keys at it", () => {
    // Every key distinct, so nothing ever collapses and the map would grow
    // without a sweep. The sweep runs on insert; there is no timer to leak.
    for (let i = 0; i < 5_000; i++) observeBurst(`k${i}`, iso(T0 + i), T0 + i);
    // The oldest keys were evicted, so re-emitting one opens a new window
    // rather than folding onto a row written hours ago.
    expect(observeBurst("k0", iso(T0 + 5_001), T0 + 5_001)).toEqual({ first: true });
  });

  it("forgets every window on reset", () => {
    observeBurst("k", iso(T0), T0);
    resetBursts();
    expect(observeBurst("k", iso(T0 + 1), T0 + 1)).toEqual({ first: true });
  });
});
