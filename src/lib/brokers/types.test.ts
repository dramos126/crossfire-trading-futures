import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, it, expect } from "vitest";

import {
  POSITION_TYPE_FLAT,
  POSITION_TYPE_LONG,
  POSITION_TYPE_SHORT,
  positionTypeFromSigned,
  signedSize,
  signedSizeForEntrySide,
  type Position,
} from "@/lib/brokers/types";
import { translatePosition } from "@/lib/brokers/tradovate/fill-mapping";
import type { TradovatePosition } from "@/lib/brokers/tradovate/types";

/** Topstep's native shape: `type` + unsigned `size`, straight off
 *  `/Position/searchOpen`. */
function topstepPosition(type: 1 | 2, size: number): Position {
  return {
    id: 501,
    accountId: 9001,
    contractId: "CON.F.US.MGC.Z26",
    creationTimestamp: "2026-08-24T14:30:00Z",
    type,
    size,
    averagePrice: 2410.5,
  };
}

/** Tradovate's native shape: signed `netPos`, run through the real
 *  translator rather than a hand-built `Position`, so these cases fail if
 *  the boundary's convention ever moves. */
function tradovatePosition(netPos: number): Position {
  const raw: TradovatePosition = {
    id: 77,
    accountId: 9001,
    contractId: 123456,
    netPos,
    avgPrice: 2410.5,
    timestamp: "2026-08-24T14:30:00Z",
  };
  return translatePosition(raw);
}

describe("signedSize", () => {
  it("reads a Topstep long as positive", () => {
    expect(signedSize(topstepPosition(POSITION_TYPE_LONG, 3))).toBe(3);
  });

  it("reads a Topstep short as negative", () => {
    expect(signedSize(topstepPosition(POSITION_TYPE_SHORT, 3))).toBe(-3);
  });

  it("reads a translated Tradovate long as positive", () => {
    expect(signedSize(tradovatePosition(3))).toBe(3);
  });

  it("reads a translated Tradovate short as negative", () => {
    expect(signedSize(tradovatePosition(-3))).toBe(-3);
  });

  it("agrees across both brokers' representations of the same position", () => {
    expect(signedSize(tradovatePosition(-2))).toBe(
      signedSize(topstepPosition(POSITION_TYPE_SHORT, 2)),
    );
  });

  it("answers zero for a flat position regardless of the type field", () => {
    expect(signedSize(topstepPosition(POSITION_TYPE_LONG, 0))).toBe(0);
    expect(signedSize(topstepPosition(POSITION_TYPE_SHORT, 0))).toBe(0);
  });

  // bugs.md A41: a flat Tradovate position was labelled SHORT, size 0.
  it("labels a flat Tradovate position flat, never short, and reads it as +0", () => {
    const flat = tradovatePosition(0);
    expect(flat.type).toBe(POSITION_TYPE_FLAT);
    expect(flat.type).not.toBe(POSITION_TYPE_SHORT);
    expect(flat.size).toBe(0);
    expect(Object.is(signedSize(flat), 0)).toBe(true);
  });

  it("reads Topstep's own flat sentinel as +0", () => {
    expect(Object.is(signedSize({ type: POSITION_TYPE_FLAT, size: 0 }), 0)).toBe(true);
  });

  it("uses the code Topstep's gateway already sends for flat", () => {
    expect(POSITION_TYPE_FLAT).toBe(0);
  });

  it("returns positive zero, never negative zero, so Object.is comparisons hold", () => {
    expect(Object.is(signedSize(topstepPosition(POSITION_TYPE_SHORT, 0)), 0)).toBe(true);
  });

  it("distinguishes an engine long 1 from a broker-reported short 1 (D-6's flip)", () => {
    const engineLong = topstepPosition(POSITION_TYPE_LONG, 1);
    const brokerShort = tradovatePosition(-1);
    expect(brokerShort.size).toBe(engineLong.size);
    // Pin the pair exactly. `.not.toBe` would survive a mutation returning
    // `size * 2` for shorts — patterns.md: assert the property, not a proxy
    // that outlives the regression.
    expect(signedSize(engineLong)).toBe(1);
    expect(signedSize(brokerShort)).toBe(-1);
  });

  it("never lets an OrderSide be read as a PositionType — they collide at 1", () => {
    // OrderSide 1 is Sell; PositionType 1 is Long. A cast between them
    // compiles and silently reads every short as a long, which is D-6's
    // exact bug class. `signedSizeForEntrySide` is the only safe bridge.
    expect(signedSizeForEntrySide(0, 2)).toBe(2);
    expect(signedSizeForEntrySide(1, 2)).toBe(-2);
    // The trap it removes, spelled out: a naive cast maps Sell onto Long.
    expect(signedSize({ type: POSITION_TYPE_LONG, size: 2 })).toBe(2);
    expect(signedSizeForEntrySide(1, 2)).not.toBe(signedSize({ type: POSITION_TYPE_LONG, size: 2 }));
  });

  it("normalises an already-signed size rather than double-negating it", () => {
    // The Pick is widened past Position, so a caller can arrive holding a
    // signed quantity. Without Math.abs this answers +2 — a short read long.
    expect(signedSize({ type: POSITION_TYPE_SHORT, size: -2 })).toBe(-2);
    expect(signedSize({ type: POSITION_TYPE_LONG, size: -2 })).toBe(2);
  });

  it("takes any value carrying type and size, not only a whole Position", () => {
    expect(signedSize({ type: POSITION_TYPE_SHORT, size: 4 })).toBe(-4);
  });
});

describe("positionTypeFromSigned", () => {
  it("maps a positive quantity to Long", () => {
    expect(positionTypeFromSigned(3)).toBe(POSITION_TYPE_LONG);
  });

  it("maps a negative quantity to Short", () => {
    expect(positionTypeFromSigned(-3)).toBe(POSITION_TYPE_SHORT);
  });

  it("maps flat to null, because PositionType cannot express it", () => {
    expect(positionTypeFromSigned(0)).toBeNull();
    expect(positionTypeFromSigned(-0)).toBeNull();
  });

  it("round-trips every non-flat quantity through signedSize", () => {
    for (const n of [1, -1, 2, -2, 17, -17]) {
      const type = positionTypeFromSigned(n);
      if (type === null) throw new Error(`expected a side for ${n}`);
      expect(signedSize({ type, size: Math.abs(n) })).toBe(n);
    }
  });
});

// bugs.md A41. Every direct side reader outside brokers/ is a
// `type === LONG ? long : short` ternary, which reads POSITION_TYPE_FLAT as
// short. Each is safe only because it sits behind a `size > 0` filter, so a
// new reader has to be checked for one and added here by name.
describe("Position.type readers outside brokers/", () => {
  const SRC = join(__dirname, "..", "..");
  const READERS: Record<string, string> = {
    "lib/trading/engine/engine-exit.ts": "refuseSideMismatch, reached only through liveOn (size > 0)",
    "lib/trading/engine/engine-exit-legs.ts": "closingSideOfPosition; its one caller is refuseSideMismatch",
    "lib/trading/engine/flatten/engine-force-flat.ts": "closingSideOf; readPosition finds size > 0 only",
    "lib/trading/engine/flatten/engine-watchdog.ts": "the position loop skips size <= 0 first",
  };

  it("names every file that reads a side constant, and nothing else does", () => {
    const found = (readdirSync(SRC, { recursive: true }) as string[])
      .map((f) => f.split(sep).join("/"))
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith("lib/brokers/"))
      .filter((f) => /\bPOSITION_TYPE_(LONG|SHORT)\b/.test(readFileSync(join(SRC, f), "utf8")))
      .sort();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(Object.keys(READERS).sort());
  });

  // The same reader written against the literal escapes the scan above.
  // `.type === 1` is also how an `OrderType` (1 Limit) is read, so the scan
  // cannot tell the two apart: each file is named with which it reads.
  const LITERAL_READERS: Record<string, string> = {
    "app/api/deployments/flatten-all/route.ts": "Position: a REST position list carries no flat entry",
    "lib/trading/engine/engine-order.ts": "Position: log text only, behind a size > 0 find",
    "lib/trading/engine/realtime/engine-reconcile.ts": "OrderType 1 (Limit) and 4 (Stop), not a Position",
    "app/api/dev/probe-trailing-stop/route.ts": "OrderType 1 (Limit), not a Position",
  };

  it("names every file that compares a .type to the literal 1 or 2, and nothing else does", () => {
    const literal = /\.type\s*[!=]==\s*[12]\b|\b[12]\s*[!=]==\s*[\w.]*\.type\b/;
    const found = (readdirSync(SRC, { recursive: true }) as string[])
      .map((f) => f.split(sep).join("/"))
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith("lib/brokers/"))
      .filter((f) => literal.test(readFileSync(join(SRC, f), "utf8")))
      .sort();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(Object.keys(LITERAL_READERS).sort());
  });
});
