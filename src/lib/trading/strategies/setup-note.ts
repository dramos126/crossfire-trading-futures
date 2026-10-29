/**
 * The wording shared by the `setupStatus` hooks — the dashboard `ARMED` chip's
 * tooltip. One sentence a trader reads on hover, so one way to print a level.
 */

/** A price level as the note prints it: thousands grouped, no more decimals than the tick has. */
export function fmtLevel(price: number, tickSize: number): string {
  const decimals = (String(tickSize).split(".")[1] ?? "").length;
  return price.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

/** `HH:MM` for a minute of the ET day. */
export function fmtClock(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "Range 21,410–21,452 set" — the opening-range playbooks' first clause; "held" for one the day kept. */
export function rangeClause(low: number, high: number, tickSize: number, state: "set" | "held" = "set"): string {
  return `Range ${fmtLevel(low, tickSize)}–${fmtLevel(high, tickSize)} ${state}`;
}
