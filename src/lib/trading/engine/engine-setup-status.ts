/**
 * The per-leg setup reading behind the dashboard's `ARMED` chip.
 *
 * **Display only.** A reading is the strategy's optional `setupStatus` answer
 * on a flat leg whose `shouldEnter` returned no signal, and nothing in the
 * engine reads it back — the chip is its one consumer. So the rules here are
 * all about never claiming a setup that is not there:
 *
 * - A bar the engine evaluates starts with no reading (`beginBar`), and only an
 *   `offer` after `shouldEnter` sets one. Every early return in between — the
 *   leg is holding, disabled, refused, outside its window, cooling down, held
 *   by the flap breaker or the outage gate — therefore settles to *none*, never
 *   to the previous bar's answer.
 * - A hook that throws reads as none and is said once per leg, never per bar.
 * - The browser is told only when the map changes, and the frame carries
 *   nothing: it re-reads the engine status route, which owns the shape.
 *
 * A controller rather than a field on `DeploymentState`: the map and its
 * pending slots are written by nothing else (engine.md, *Extraction pattern*).
 */

import type { SetupReading, StrategyContext, StrategyModule } from "@/lib/trading/strategy-types";

export interface SetupReadingsDeps {
  /** The map changed. Best-effort — a missing relay is the pre-boot state. */
  emitChanged(): void;
  /** The leg's hook threw; called at most once per leg until `reset`/`retain` drops it. */
  warnHookFailed(deploymentId: string, message: string): void;
}

/** What the hook answered, narrowed: anything but a non-empty `note` is no reading. */
export function readSetupStatus(
  strategy: StrategyModule,
  ctx: StrategyContext,
): { note: string | null; error: string | null } {
  if (!strategy.setupStatus) return { note: null, error: null };
  let answer: SetupReading | null;
  try {
    answer = strategy.setupStatus(ctx);
  } catch (err) {
    return { note: null, error: err instanceof Error ? err.message : String(err) };
  }
  const note = answer != null && typeof answer.note === "string" ? answer.note.trim() : "";
  return { note: note.length > 0 ? note : null, error: null };
}

export class SetupReadings {
  private readonly readings = new Map<string, string>();
  /** Legs with a bar in flight, and the reading that bar has earned so far. */
  private readonly pending = new Map<string, string | null>();
  private readonly warned = new Set<string>();

  constructor(private readonly deps: SetupReadingsDeps) {}

  /** A new bar is being evaluated for this leg: until `offer`, it has no reading. */
  beginBar(deploymentId: string): void {
    this.pending.set(deploymentId, null);
  }

  /** `shouldEnter` returned no signal on the bar in flight: ask the hook. */
  offer(deploymentId: string, strategy: StrategyModule, ctx: StrategyContext): void {
    if (!this.pending.has(deploymentId)) return;
    const { note, error } = readSetupStatus(strategy, ctx);
    if (error != null && !this.warned.has(deploymentId)) {
      this.warned.add(deploymentId);
      this.deps.warnHookFailed(
        deploymentId,
        `Setup status hook threw (${error}) — the dashboard shows this leg as flat. Entries are unaffected.`,
      );
    }
    this.pending.set(deploymentId, note);
  }

  /** The bar is done, however it ended: publish what it earned. No bar in flight, no change. */
  settle(deploymentId: string): void {
    if (!this.pending.has(deploymentId)) return;
    const note = this.pending.get(deploymentId) ?? null;
    this.pending.delete(deploymentId);
    this.write(deploymentId, note);
  }

  /** The leg cannot be armed whatever its last bar said. */
  clear(deploymentId: string): void {
    this.pending.delete(deploymentId);
    this.write(deploymentId, null);
  }

  /** Keep only these legs' readings — the sync's entry-eligible set. */
  retain(deploymentIds: ReadonlySet<string>): void {
    let changed = false;
    for (const id of [...this.readings.keys()]) {
      if (deploymentIds.has(id)) continue;
      this.readings.delete(id);
      changed = true;
    }
    // A bar in flight on a dropped leg read the tick's old row, so its settle
    // would write the reading straight back.
    for (const id of [...this.pending.keys()]) if (!deploymentIds.has(id)) this.pending.delete(id);
    for (const id of [...this.warned]) if (!deploymentIds.has(id)) this.warned.delete(id);
    if (changed) this.deps.emitChanged();
  }

  /** Engine stop: nothing is armed on a stopped engine. */
  reset(): void {
    const had = this.readings.size > 0;
    this.readings.clear();
    this.pending.clear();
    this.warned.clear();
    if (had) this.deps.emitChanged();
  }

  /** Deployment id → note, for the status route. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.readings);
  }

  private write(deploymentId: string, note: string | null): void {
    const previous = this.readings.get(deploymentId) ?? null;
    if (previous === note) return;
    if (note == null) this.readings.delete(deploymentId);
    else this.readings.set(deploymentId, note);
    this.deps.emitChanged();
  }
}
