/**
 * The regime selector, as a predicate over the shared hooks.
 *
 * `withRegimeGate` wraps a strategy module so an entry it would have taken
 * on a session whose label is outside the allowed set becomes `null`. That
 * is the whole selector: a gate on `shouldEnter` reading a label computed
 * from bars both the engine and the backtest have, rather than a scheduler
 * arming and disarming deployments on a clock — a scheduler is a second
 * lifecycle actor and is unreachable from a backtest.
 *
 * The CLI wraps the module it loaded and supplies `labelForBar` from its own
 * session-day series; phase 3 lifts the same function into the platform with
 * the label coming from `regime_days`. Nothing else about the module
 * changes, which is what keeps the two paths one path.
 */
import type { BarData } from "@/lib/brokers/types";
import type { EntrySignal, EntrySkip, StrategyModule } from "@/lib/trading/strategy-types";

/** The skip's stable gate id, and the key it counts under. */
export const REGIME_SKIP_GATE = "regime";

export interface RegimeGateArgs {
  /** Cells the playbook may trade. A label outside it stands the entry down. */
  allowed: ReadonlySet<string>;
  /** The label of the session the bar falls in — `"unknown"` included, which
   *  is never in `allowed` and therefore always stands down. */
  labelForBar: (bar: BarData) => string;
  /** Called once per stood-down entry with the label that refused it and the
   *  signal bar — the pair a skipped signal has to be persisted under. */
  onSkip?: (label: string, bar: BarData) => void;
}

/**
 * The inner hook runs first and its result decides whether anything was
 * skipped at all: "the strategy wanted in and the label refused" is the
 * event worth counting, and it is not knowable without asking the strategy.
 * The hooks are pure, so asking costs nothing but the call.
 */
export function withRegimeGate(strategy: StrategyModule, args: RegimeGateArgs): StrategyModule {
  return {
    ...strategy,
    shouldEnter(ctx): EntrySignal | EntrySkip | null {
      const signal = strategy.shouldEnter(ctx);
      if (signal == null || "skip" in signal) return signal;

      const bar = ctx.bars[ctx.barIndex];
      if (bar == null) return signal;

      const label = args.labelForBar(bar);
      if (args.allowed.has(label)) return signal;

      args.onSkip?.(label, bar);
      return null;
    },
  };
}
