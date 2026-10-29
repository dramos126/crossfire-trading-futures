import type { WireLogRecord } from "@/lib/logging/pipe";

/**
 * The stream's `logLine` frames, handed to whichever `/logs` viewer is
 * mounted. A plain fan-out rather than state: only that page wants the lines,
 * and it folds them into the payload it fetched (`appendLogLine`).
 */

type LogLineListener = (record: WireLogRecord) => void;

const listeners = new Set<LogLineListener>();

function isText(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * A frame's record, narrowed at the boundary to the fields every lane reads
 * as text. `seq` and `burstCount` are defaulted where the lanes read them as
 * numbers, as they are for the fetched payload.
 */
export function toWireLogRecord(value: unknown): WireLogRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const textual = [r.timestamp, r.deploymentId, r.level, r.message, r.severity, r.category];
  return textual.every(isText) ? (value as WireLogRecord) : null;
}

export function publishLogLine(value: unknown): void {
  const record = toWireLogRecord(value);
  if (!record) return;
  for (const listener of listeners) listener(record);
}

export function subscribeLogLines(listener: LogLineListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
