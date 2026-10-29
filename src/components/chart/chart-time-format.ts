/**
 * 12-hour time labels for the lightweight-charts time axis and crosshair,
 * shared by the live trade chart and the run chart.
 *
 * The candles' times are already ET wall clock written as UTC
 * (`convertUtcToEtDisplay`), so these read the UTC fields and apply no zone —
 * applying one would shift every label by the ET offset a second time.
 *
 * Owned by docs/modules/ui/design-language.md, "Chart markers".
 */
import { TickMarkType, type Time, type UTCTimestamp } from "lightweight-charts";
import { convertUtcToEtDisplay } from "@/components/chart/trade-markers";

export const HOURS_PER_HALF_DAY = 12;
const MS_PER_SECOND = 1000;
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `9:45 AM`, `12:00 PM`, `1:05 PM` for a display-time second. */
export function formatClock12h(displaySeconds: number): string {
  const d = new Date(displaySeconds * MS_PER_SECOND);
  const hour = d.getUTCHours();
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  const suffix = hour < HOURS_PER_HALF_DAY ? "AM" : "PM";
  return `${hour % HOURS_PER_HALF_DAY || HOURS_PER_HALF_DAY}:${minute} ${suffix}`;
}

/** The crosshair's time label: `Tue 05 Jul '22 1:05 PM`, the library's date
 *  layout with a 12-hour clock. */
export function formatCrosshairTime12h(displaySeconds: number): string {
  const d = new Date(displaySeconds * MS_PER_SECOND);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const year = String(d.getUTCFullYear() % 100).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]} ${day} ${MONTHS[d.getUTCMonth()]} '${year} ${formatClock12h(displaySeconds)}`;
}

/** Time-axis tick marks: a 12-hour clock for intraday ticks, and null — the
 *  library's own date label — for a day, month or year boundary. */
export function tickMark12h(time: Time, type: TickMarkType): string | null {
  if (typeof time !== "number") return null;
  return type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds ? formatClock12h(time) : null;
}

const SECONDS_PER_MINUTE = 60;

/** The display time of the bar a live quote stamped `iso` belongs to, for a
 *  timeframe of `minutes`; null when the stamp cannot be read.
 *
 *  Floored after the ET projection, never before: a UTC floor projected to ET
 *  starts a 4h or daily bucket an hour apart on either side of a DST change,
 *  so the live candle stopped landing on the bars it extends. */
export function liveBarTime(iso: string, minutes: number): UTCTimestamp | null {
  if (!Number.isFinite(new Date(iso).getTime())) return null;
  const displaySeconds = convertUtcToEtDisplay(iso);
  const bucketSeconds = minutes * SECONDS_PER_MINUTE;
  return (Math.floor(displaySeconds / bucketSeconds) * bucketSeconds) as UTCTimestamp;
}

/** The crosshair label for any `Time`; the chart only ever holds numbers. */
export function crosshairTime12h(time: Time): string {
  return typeof time === "number" ? formatCrosshairTime12h(time) : String(time);
}
