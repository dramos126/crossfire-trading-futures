// Step 5 validation harness for the legacy CommonParam BE/trail migration
// shim that landed in step 4 (`migrateLegacyParamOverrides` in
// `src/lib/trading/strategy-types.ts`).
//
// The shim translates seven retired CommonParam keys
// (`breakEvenEnabled`, `breakEvenAtPct`, `breakEvenOffsetTicks`,
// `trailEnabled`, `trailArmAtPct`, `trailDistanceTicks`,
// `trailUseSlDistance`) into their registry-filter equivalents
// (`breakEvenFilter*`, `trailFilter*`) at every param-load site.
//
// This file ports the BE/trail translation block verbatim from the TS
// source so we can exercise it from Node without a TS runner. If the
// source ever changes, update this port to match — the test cases
// below are the contract.
//
// Run: node scripts/validate-be-trail-migration-shim.mjs

// ── Verbatim port of the BE/trail block from migrateLegacyParamOverrides ──

function migrateLegacyBeTrail(strategyKey, overrides, context) {
  if (!overrides) return { result: {}, migratedBE: false, migratedTrail: false, tag: strategyKey };
  const next = { ...overrides };
  const tag = context?.deploymentId ?? strategyKey;

  let migratedBE = false;
  let migratedTrail = false;
  if ("breakEvenEnabled" in next) {
    const enabled = Boolean(next.breakEvenEnabled);
    if (enabled) {
      if (!("breakEvenFilterEnabled" in next)) next.breakEvenFilterEnabled = true;
      if (!("breakEvenFilterMode" in next)) next.breakEvenFilterMode = "pct";
      if ("breakEvenAtPct" in next && !("breakEvenFilterAtPct" in next)) {
        const v = Number(next.breakEvenAtPct);
        if (Number.isFinite(v) && v > 0) next.breakEvenFilterAtPct = v;
      }
      if ("breakEvenOffsetTicks" in next && !("breakEvenFilterOffsetTicks" in next)) {
        const v = Number(next.breakEvenOffsetTicks);
        if (Number.isFinite(v)) next.breakEvenFilterOffsetTicks = v;
      }
      migratedBE = true;
    }
    delete next.breakEvenEnabled;
    delete next.breakEvenAtPct;
    delete next.breakEvenOffsetTicks;
  } else if ("breakEvenAtPct" in next || "breakEvenOffsetTicks" in next) {
    delete next.breakEvenAtPct;
    delete next.breakEvenOffsetTicks;
  }

  if ("trailEnabled" in next) {
    const enabled = Boolean(next.trailEnabled);
    if (enabled) {
      if (!("trailFilterEnabled" in next)) next.trailFilterEnabled = true;
      if (!("trailFilterMode" in next)) next.trailFilterMode = "ticks";
      if (!("trailFilterArmAtR" in next) && "trailArmAtPct" in next) {
        const pct = Number(next.trailArmAtPct);
        const rrRaw = Number(next.riskRewardRatio);
        const rr = Number.isFinite(rrRaw) && rrRaw > 0 ? rrRaw : 2;
        if (Number.isFinite(pct) && pct > 0) {
          next.trailFilterArmAtR = (pct * rr) / 100;
        }
      }
      if (!("trailFilterDistanceTicks" in next) && "trailDistanceTicks" in next) {
        const v = Number(next.trailDistanceTicks);
        if (Number.isFinite(v) && v > 0) next.trailFilterDistanceTicks = v;
      }
      migratedTrail = true;
    }
    delete next.trailEnabled;
    delete next.trailArmAtPct;
    delete next.trailDistanceTicks;
    delete next.trailUseSlDistance;
  } else if (
    "trailArmAtPct" in next ||
    "trailDistanceTicks" in next ||
    "trailUseSlDistance" in next
  ) {
    delete next.trailArmAtPct;
    delete next.trailDistanceTicks;
    delete next.trailUseSlDistance;
  }

  return { result: next, migratedBE, migratedTrail, tag };
}

// ── Test harness ──────────────────────────────────────────────────────

let passes = 0;
let fails = 0;
const failures = [];

function assertEqual(label, actual, expected) {
  const a = JSON.stringify(actual, Object.keys(actual ?? {}).sort());
  const e = JSON.stringify(expected, Object.keys(expected ?? {}).sort());
  if (a === e) {
    passes++;
    console.log(`PASS  ${label}`);
  } else {
    fails++;
    failures.push({ label, actual, expected });
    console.log(`FAIL  ${label}`);
    console.log(`        expected: ${e}`);
    console.log(`        actual:   ${a}`);
  }
}

function assertHasKey(label, obj, key) {
  if (key in obj) {
    passes++;
    console.log(`PASS  ${label}`);
  } else {
    fails++;
    failures.push({ label, actual: Object.keys(obj), expected: key });
    console.log(`FAIL  ${label} (missing key '${key}')`);
  }
}

function assertNoKey(label, obj, key) {
  if (!(key in obj)) {
    passes++;
    console.log(`PASS  ${label}`);
  } else {
    fails++;
    failures.push({ label, actual: obj[key], expected: "absent" });
    console.log(`FAIL  ${label} (key '${key}' should be absent, has value ${JSON.stringify(obj[key])})`);
  }
}

// ── Cases ────────────────────────────────────────────────────────────

console.log("\n=== Case (a): BE enabled, pct=50, RR=2 ===");
{
  const input = { breakEvenEnabled: true, breakEvenAtPct: 50, riskRewardRatio: 2 };
  const { result, migratedBE, migratedTrail } = migrateLegacyBeTrail("test", input, {});
  assertEqual("breakEvenFilterEnabled=true", result.breakEvenFilterEnabled, true);
  assertEqual("breakEvenFilterMode='pct'", result.breakEvenFilterMode, "pct");
  assertEqual("breakEvenFilterAtPct=50 (preserved verbatim)", result.breakEvenFilterAtPct, 50);
  assertNoKey("legacy breakEvenEnabled stripped", result, "breakEvenEnabled");
  assertNoKey("legacy breakEvenAtPct stripped", result, "breakEvenAtPct");
  assertNoKey("breakEvenFilterAtR NOT computed (faithful pct-mode translation)", result, "breakEvenFilterAtR");
  assertEqual("migratedBE flag set", migratedBE, true);
  assertEqual("migratedTrail flag NOT set", migratedTrail, false);
  // Verify riskRewardRatio passes through untouched.
  assertEqual("riskRewardRatio passed through", result.riskRewardRatio, 2);
}

console.log("\n=== Case (b): BE enabled with offset ticks ===");
{
  const input = {
    breakEvenEnabled: true,
    breakEvenAtPct: 50,
    breakEvenOffsetTicks: 2,
    riskRewardRatio: 2,
  };
  const { result } = migrateLegacyBeTrail("test", input, {});
  assertEqual("breakEvenFilterEnabled=true", result.breakEvenFilterEnabled, true);
  assertEqual("breakEvenFilterMode='pct'", result.breakEvenFilterMode, "pct");
  assertEqual("breakEvenFilterAtPct=50", result.breakEvenFilterAtPct, 50);
  assertEqual("breakEvenFilterOffsetTicks=2", result.breakEvenFilterOffsetTicks, 2);
  assertNoKey("legacy breakEvenOffsetTicks stripped", result, "breakEvenOffsetTicks");
}

console.log("\n=== Case (c): BE disabled, residual stale params lurking ===");
{
  const input = {
    breakEvenEnabled: false,
    breakEvenAtPct: 50,
    breakEvenOffsetTicks: 2,
  };
  const { result, migratedBE } = migrateLegacyBeTrail("test", input, {});
  assertNoKey("legacy breakEvenEnabled stripped", result, "breakEvenEnabled");
  assertNoKey("legacy breakEvenAtPct stripped", result, "breakEvenAtPct");
  assertNoKey("legacy breakEvenOffsetTicks stripped", result, "breakEvenOffsetTicks");
  assertNoKey("breakEvenFilterEnabled NOT set (BE was off)", result, "breakEvenFilterEnabled");
  assertNoKey("breakEvenFilterMode NOT set (BE was off)", result, "breakEvenFilterMode");
  assertNoKey("breakEvenFilterAtPct NOT set (BE was off)", result, "breakEvenFilterAtPct");
  assertEqual("migratedBE flag NOT set", migratedBE, false);
}

console.log("\n=== Case (c2): BE flag absent but stale BE params present (legacy disabled-form) ===");
{
  // Pre-shim deployments could have breakEvenAtPct stored without breakEvenEnabled
  // (old default was breakEvenEnabled=true so the field may have been present
  // previously). The shim's `else if` branch should strip the residuals.
  const input = { breakEvenAtPct: 50, breakEvenOffsetTicks: 2 };
  const { result, migratedBE } = migrateLegacyBeTrail("test", input, {});
  assertNoKey("residual breakEvenAtPct stripped", result, "breakEvenAtPct");
  assertNoKey("residual breakEvenOffsetTicks stripped", result, "breakEvenOffsetTicks");
  assertNoKey("breakEvenFilterEnabled NOT set", result, "breakEvenFilterEnabled");
  assertEqual("migratedBE flag NOT set (no breakEvenEnabled present)", migratedBE, false);
}

console.log("\n=== Case (d): trail enabled, armPct=50, distanceTicks=10, RR=2 ===");
{
  const input = {
    trailEnabled: true,
    trailArmAtPct: 50,
    trailDistanceTicks: 10,
    riskRewardRatio: 2,
  };
  const { result, migratedTrail } = migrateLegacyBeTrail("test", input, {});
  assertEqual("trailFilterEnabled=true", result.trailFilterEnabled, true);
  assertEqual("trailFilterMode='ticks'", result.trailFilterMode, "ticks");
  // Formula: (pct × RR) / 100 = (50 × 2) / 100 = 1.0
  assertEqual("trailFilterArmAtR=1.0 (formula: pct×RR/100)", result.trailFilterArmAtR, 1.0);
  assertEqual("trailFilterDistanceTicks=10 (preserved verbatim)", result.trailFilterDistanceTicks, 10);
  assertNoKey("legacy trailEnabled stripped", result, "trailEnabled");
  assertNoKey("legacy trailArmAtPct stripped", result, "trailArmAtPct");
  assertNoKey("legacy trailDistanceTicks stripped", result, "trailDistanceTicks");
  assertEqual("migratedTrail flag set", migratedTrail, true);
}

console.log("\n=== Case (d2): trail with non-default RR (RR=3, pct=50) ===");
{
  const input = {
    trailEnabled: true,
    trailArmAtPct: 50,
    trailDistanceTicks: 8,
    riskRewardRatio: 3,
  };
  const { result } = migrateLegacyBeTrail("test", input, {});
  // (50 × 3) / 100 = 1.5
  assertEqual("trailFilterArmAtR=1.5", result.trailFilterArmAtR, 1.5);
}

console.log("\n=== Case (d3): trail with missing RR (defaults to 2 in shim) ===");
{
  const input = { trailEnabled: true, trailArmAtPct: 50, trailDistanceTicks: 10 };
  const { result } = migrateLegacyBeTrail("test", input, {});
  // RR defaults to 2 → (50 × 2) / 100 = 1.0
  assertEqual("trailFilterArmAtR=1.0 with default RR=2", result.trailFilterArmAtR, 1.0);
}

console.log("\n=== Case (e): trail enabled with trailUseSlDistance=true (dropped silently) ===");
{
  const input = {
    trailEnabled: true,
    trailUseSlDistance: true,
    trailArmAtPct: 50,
    trailDistanceTicks: 10,
    riskRewardRatio: 2,
  };
  const { result, migratedTrail } = migrateLegacyBeTrail("test", input, {});
  assertEqual("trailFilterEnabled=true", result.trailFilterEnabled, true);
  assertNoKey("trailUseSlDistance dropped silently (no equivalent in new filter)", result, "trailUseSlDistance");
  assertEqual("migratedTrail flag set", migratedTrail, true);
}

console.log("\n=== Case (f): combined BE + trail both enabled ===");
{
  const input = {
    breakEvenEnabled: true,
    breakEvenAtPct: 50,
    breakEvenOffsetTicks: 2,
    trailEnabled: true,
    trailArmAtPct: 50,
    trailDistanceTicks: 10,
    riskRewardRatio: 2,
  };
  const { result, migratedBE, migratedTrail } = migrateLegacyBeTrail("test", input, {});
  // BE block
  assertEqual("BE: breakEvenFilterEnabled=true", result.breakEvenFilterEnabled, true);
  assertEqual("BE: breakEvenFilterMode='pct'", result.breakEvenFilterMode, "pct");
  assertEqual("BE: breakEvenFilterAtPct=50", result.breakEvenFilterAtPct, 50);
  assertEqual("BE: breakEvenFilterOffsetTicks=2", result.breakEvenFilterOffsetTicks, 2);
  // Trail block
  assertEqual("Trail: trailFilterEnabled=true", result.trailFilterEnabled, true);
  assertEqual("Trail: trailFilterMode='ticks'", result.trailFilterMode, "ticks");
  assertEqual("Trail: trailFilterArmAtR=1.0", result.trailFilterArmAtR, 1.0);
  assertEqual("Trail: trailFilterDistanceTicks=10", result.trailFilterDistanceTicks, 10);
  // Both flags
  assertEqual("migratedBE set", migratedBE, true);
  assertEqual("migratedTrail set", migratedTrail, true);
  // No collision: BE keys did not get overwritten by trail block
  // and vice versa (sanity — they target different namespaces).
  assertEqual("No cross-pollution: trailFilterMode='ticks' (not 'pct')", result.trailFilterMode, "ticks");
  assertEqual("No cross-pollution: breakEvenFilterMode='pct' (not 'ticks')", result.breakEvenFilterMode, "pct");
}

console.log("\n=== Case (g): no legacy keys (post-step-4 fresh deployment) ===");
{
  const input = {
    riskRewardRatio: 2,
    size: 1,
    cooldownSeconds: 60,
    breakEvenFilterEnabled: true,
    breakEvenFilterMode: "r",
    breakEvenFilterAtR: 1.0,
  };
  const { result, migratedBE, migratedTrail } = migrateLegacyBeTrail("test", input, {});
  assertEqual("no migration fired (BE)", migratedBE, false);
  assertEqual("no migration fired (trail)", migratedTrail, false);
  assertEqual("breakEvenFilterEnabled passed through", result.breakEvenFilterEnabled, true);
  assertEqual("breakEvenFilterMode='r' passed through", result.breakEvenFilterMode, "r");
  assertEqual("breakEvenFilterAtR=1.0 passed through", result.breakEvenFilterAtR, 1.0);
  assertEqual("riskRewardRatio passed through", result.riskRewardRatio, 2);
  assertEqual("size passed through", result.size, 1);
}

console.log("\n=== Case (h): pre-existing breakEvenFilter* takes precedence over legacy ===");
{
  // Defensive: if a deployment somehow has BOTH legacy and new keys (e.g.
  // user hand-edited the DB), the shim must not clobber the explicit new
  // value. The implementation uses `if (!('breakEvenFilterEnabled' in next))`.
  const input = {
    breakEvenEnabled: true,
    breakEvenAtPct: 50,
    breakEvenFilterEnabled: false, // user explicitly disabled in new schema
    breakEvenFilterMode: "r",
    breakEvenFilterAtR: 2.0,
  };
  const { result } = migrateLegacyBeTrail("test", input, {});
  assertEqual("breakEvenFilterEnabled NOT clobbered (stays false)", result.breakEvenFilterEnabled, false);
  assertEqual("breakEvenFilterMode NOT clobbered (stays 'r')", result.breakEvenFilterMode, "r");
  assertEqual("breakEvenFilterAtR NOT clobbered (stays 2.0)", result.breakEvenFilterAtR, 2.0);
  assertNoKey("legacy breakEvenEnabled still stripped", result, "breakEvenEnabled");
  assertNoKey("legacy breakEvenAtPct still stripped (no AtPct in new schema since mode='r')", result, "breakEvenAtPct");
}

console.log("\n=== Case (i): undefined/empty input ===");
{
  const { result } = migrateLegacyBeTrail("test", undefined, {});
  assertEqual("undefined input → empty object", result, {});
}
{
  const { result, migratedBE, migratedTrail } = migrateLegacyBeTrail("test", {}, {});
  assertEqual("empty input → empty object", result, {});
  assertEqual("no BE migration", migratedBE, false);
  assertEqual("no trail migration", migratedTrail, false);
}

console.log("\n=== Case (j): non-finite legacy values are skipped ===");
{
  // Defensive: a corrupt DB row with NaN/string in numeric fields
  // shouldn't pollute the new keys.
  const input = {
    breakEvenEnabled: true,
    breakEvenAtPct: "not a number",
    breakEvenOffsetTicks: NaN,
    riskRewardRatio: 2,
  };
  const { result } = migrateLegacyBeTrail("test", input, {});
  assertEqual("breakEvenFilterEnabled=true", result.breakEvenFilterEnabled, true);
  assertNoKey("breakEvenFilterAtPct NOT set (NaN/string skipped)", result, "breakEvenFilterAtPct");
  assertNoKey("breakEvenFilterOffsetTicks NOT set (NaN skipped)", result, "breakEvenFilterOffsetTicks");
}

console.log("\n=== Case (k): immutability — caller's object not mutated ===");
{
  const input = {
    breakEvenEnabled: true,
    breakEvenAtPct: 50,
    riskRewardRatio: 2,
  };
  const inputSnapshot = JSON.stringify(input);
  migrateLegacyBeTrail("test", input, {});
  assertEqual("caller's input unchanged", JSON.stringify(input), inputSnapshot);
}

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== SUMMARY: ${passes} PASS, ${fails} FAIL ===`);
if (fails > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - ${f.label}`);
  }
  process.exit(1);
}
process.exit(0);
