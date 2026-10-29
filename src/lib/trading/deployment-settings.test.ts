/**
 * `checkDeploymentSettings` — every setting converted to its param's declared
 * type at the API, what does not convert refused naming the setting, and the
 * module's own settings refusal run on the result (A113).
 */
import { describe, it, expect, vi } from "vitest";
import { checkDeploymentSettings } from "./deployment-settings";
import {
  PLAYBOOK_MAX_CONTRACTS_REFUSAL,
  PLAYBOOK_RISK_PERCENT_REFUSAL,
  REVIEWED_MAX_CONTRACTS,
} from "@/lib/trading/orders/risk-sizer";
import {
  withCommonParams,
  type CommonParams,
  type ParamValues,
  type StrategyModule,
} from "@/lib/trading/strategy-types";
import { offCalibrationKeys } from "@/lib/trading/param-explore";
import { loadStrategiesNode } from "@/lib/trading/strategies/load-node";

const TRADES_A_NIGHT_REFUSAL = "Trades a night must be at least the 1 the rule takes.";
const OFF_BAND_PAD =
  "Stop pad (ATR) is calibrated from 0.75 to 1.25, and 0.5 is outside it. A deployment trades only calibrated values; Try settings runs any other as research.";
const OFF_BAND_MAX_STOP =
  "Max stop (ticks) is calibrated from 100 to 300, or 0 for off, and 50 is outside it. A deployment trades only calibrated values; Try settings runs any other as research.";

const settingsRefusal = vi.fn((params: CommonParams) =>
  (params.tradesPerNight as number) < 1 ? TRADES_A_NIGHT_REFUSAL : null,
);

const module: Pick<StrategyModule, "params" | "settingsRefusal"> = {
  params: withCommonParams({
    emaLength: { type: "integer", label: "Hourly EMA length", default: 21 },
    stopAtr: { type: "number", label: "Stop (ATR multiple)", default: 1.5 },
    tradesPerNight: { type: "integer", label: "Trades a night", default: 1 },
    useLevelExit: { type: "boolean", label: "Exit at the level", default: false },
    entryMode: {
      type: "select",
      label: "Entry",
      default: "close",
      options: [
        { value: "close", label: "On the close" },
        { value: "retest", label: "On a retest" },
      ],
    },
    rewardMultiple: {
      type: "select",
      label: "Target (R)",
      default: "2",
      options: [
        { value: "1.5", label: "1.5R" },
        { value: "2", label: "2R" },
      ],
    },
    cutoff: { type: "time", label: "Last entry", default: "11:00" },
    stopAtrPad: {
      type: "number",
      label: "Stop pad (ATR)",
      default: 1,
      min: 0.75,
      max: 1.25,
      calibrated: { kind: "range", min: 0.75, max: 1.25 },
    },
    maxStopTicks: {
      type: "integer",
      label: "Max stop (ticks)",
      default: 200,
      min: 100,
      max: 300,
      calibrated: { kind: "rangeOrOff", min: 100, max: 300 },
    },
  }),
  settingsRefusal,
};

function check(values: Record<string, unknown>, mod: typeof module | undefined = module) {
  return checkDeploymentSettings({ strategyKey: "fixture", ticker: "/MNQ", module: mod, values });
}

describe("checkDeploymentSettings — conversion by declared type", () => {
  it("stores a number param sent as text as the number", () => {
    expect(check({ emaLength: "21", stopAtr: " 1.25 " })).toEqual({
      ok: true,
      values: { emaLength: 21, stopAtr: 1.25 },
    });
  });

  it("refuses text that is no number, naming the setting", () => {
    expect(check({ emaLength: "abc" })).toEqual({
      ok: false,
      error: 'Hourly EMA length must be a whole number, and "abc" is not one.',
    });
    expect(check({ stopAtr: "abc" })).toEqual({
      ok: false,
      error: 'Stop (ATR multiple) must be a number, and "abc" is not one.',
    });
  });

  it("refuses a fraction for a whole-number param and null for any number", () => {
    expect(check({ emaLength: 21.5 })).toMatchObject({ ok: false, error: expect.stringContaining("Hourly EMA length") });
    expect(check({ stopAtr: null })).toMatchObject({ ok: false, error: expect.stringContaining("Stop (ATR multiple)") });
  });

  it("coerces a boolean sent as text and refuses anything else", () => {
    expect(check({ useLevelExit: "true" })).toEqual({ ok: true, values: { useLevelExit: true } });
    expect(check({ useLevelExit: "false" })).toEqual({ ok: true, values: { useLevelExit: false } });
    expect(check({ useLevelExit: 1 })).toEqual({
      ok: false,
      error: "Exit at the level is on or off (true or false), and 1 is neither.",
    });
    // An inherited property name is not a boolean.
    expect(check({ useLevelExit: "constructor" }).ok).toBe(false);
  });

  it("coerces an option sent as a number to its string value and refuses one off the list", () => {
    expect(check({ rewardMultiple: 2, entryMode: "retest" })).toEqual({
      ok: true,
      values: { rewardMultiple: "2", entryMode: "retest" },
    });
    expect(check({ entryMode: "open" })).toEqual({
      ok: false,
      error: 'Entry must be one of On the close, On a retest, and "open" is not one of them.',
    });
  });

  it("refuses a clock time that does not parse", () => {
    expect(check({ cutoff: "10:30" })).toEqual({ ok: true, values: { cutoff: "10:30" } });
    expect(check({ cutoff: "25:00" })).toMatchObject({ ok: false, error: expect.stringContaining("Last entry") });
  });

  it("passes a key the schema does not declare unchanged", () => {
    expect(check({ retiredKey: "21" })).toEqual({ ok: true, values: { retiredKey: "21" } });
  });
});

describe("checkDeploymentSettings — the module's settings refusal", () => {
  it("refuses what the module's own check rejects, on the converted and merged values", () => {
    expect(check({ tradesPerNight: "0" })).toEqual({ ok: false, error: TRADES_A_NIGHT_REFUSAL });
    expect(settingsRefusal).toHaveBeenLastCalledWith(
      expect.objectContaining({ tradesPerNight: 0, emaLength: 21 }),
      expect.objectContaining({ start: "09:30" }),
    );
  });

  it("passes what the module's own check accepts", () => {
    expect(check({ tradesPerNight: "2" })).toEqual({ ok: true, values: { tradesPerNight: 2 } });
  });
});

describe("A114 — a live row cannot save a setting outside its calibrated range", () => {
  it("refuses a calibrated number outside its band, naming the setting and the range", () => {
    expect(check({ stopAtrPad: 0.5 })).toEqual({ ok: false, error: OFF_BAND_PAD });
    expect(check({ stopAtrPad: "1.5" })).toMatchObject({ ok: false, error: expect.stringContaining("Stop pad (ATR)") });
  });

  it("takes a value inside the band, and a rangeOrOff param's off value", () => {
    expect(check({ stopAtrPad: 1.25, maxStopTicks: 0 })).toEqual({
      ok: true,
      values: { stopAtrPad: 1.25, maxStopTicks: 0 },
    });
    expect(check({ maxStopTicks: 50 })).toEqual({ ok: false, error: OFF_BAND_MAX_STOP });
  });

  it("never refuses a registered playbook's own defaults", async () => {
    // A default outside its own band would make every deploy of that
    // playbook a 400 the operator cannot clear.
    const modules = await loadStrategiesNode({ includeTest: false });
    const offending = Object.entries(modules).flatMap(([key, mod]) => {
      const defaults = Object.fromEntries(
        Object.entries(mod.params).map(([k, p]) => [k, p.default]),
      ) as ParamValues;
      return offCalibrationKeys(mod.params, defaults).map((k) => `${key}.${k}`);
    });
    expect(offending).toEqual([]);
  }, 60_000);

  it("does not refuse a stored value the edit leaves unchanged", () => {
    // A row saved before the check would otherwise 400 on every unrelated edit.
    expect(
      checkDeploymentSettings({
        strategyKey: "fixture",
        ticker: "/MNQ",
        module,
        values: { stopAtrPad: 0.5, emaLength: 34 },
        stored: { stopAtrPad: 0.5, emaLength: 21 },
      }),
    ).toEqual({ ok: true, values: { stopAtrPad: 0.5, emaLength: 34 } });
    expect(
      checkDeploymentSettings({
        strategyKey: "fixture",
        ticker: "/MNQ",
        module,
        values: { stopAtrPad: 0.6 },
        stored: { stopAtrPad: 0.5 },
      }).ok,
    ).toBe(false);
  });

  it("does not refuse an unchanged value a pre-A113 row stored as text", () => {
    // The stored side is converted like the edit before comparing.
    expect(
      checkDeploymentSettings({
        strategyKey: "fixture",
        ticker: "/MNQ",
        module,
        values: { stopAtrPad: 0.5, emaLength: 34 },
        stored: { stopAtrPad: "0.5", emaLength: 21 },
      }),
    ).toEqual({ ok: true, values: { stopAtrPad: 0.5, emaLength: 34 } });
  });
});

describe("checkDeploymentSettings — the playbook sizing settings, as before", () => {
  it("converts numeric text for both and leaves other keys converted by their own type", () => {
    expect(check({ playbookMaxContracts: "1", playbookRiskPercent: " 50 ", cooldownSeconds: 0 })).toEqual({
      ok: true,
      values: { playbookMaxContracts: 1, playbookRiskPercent: 50, cooldownSeconds: 0 },
    });
  });

  it("converts them for a playbook this build does not register", () => {
    expect(check({ playbookMaxContracts: "2" }, undefined)).toEqual({ ok: true, values: { playbookMaxContracts: 2 } });
  });

  it("passes when neither is present, and takes 0 as no cap", () => {
    expect(check({})).toEqual({ ok: true, values: {} });
    expect(check({ playbookMaxContracts: 0 })).toMatchObject({ ok: true });
  });

  for (const value of [-1, 1.5, REVIEWED_MAX_CONTRACTS + 1, "two", "", null, true]) {
    it(`refuses a cap of ${JSON.stringify(value)} with the sizer's sentence`, () => {
      expect(check({ playbookMaxContracts: value })).toEqual({ ok: false, error: PLAYBOOK_MAX_CONTRACTS_REFUSAL });
    });
  }

  for (const value of [0, -5, 101, 12.5, "half", null]) {
    it(`refuses a share of ${JSON.stringify(value)} with the sizer's sentence`, () => {
      expect(check({ playbookRiskPercent: value })).toEqual({ ok: false, error: PLAYBOOK_RISK_PERCENT_REFUSAL });
    });
  }
});
