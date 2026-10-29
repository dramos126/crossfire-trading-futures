/**
 * Databento metadata calls used to probe entitlement.
 *
 * Databento has **no entitlements endpoint** — the metadata API's methods
 * cover publishers, datasets, schemas, fields, unit prices, dataset
 * condition/range, record count, billable size and cost, and none of them
 * reports what a key may access. `metadata.get_dataset_range` is the
 * closest thing: it is documented as returning the available range *given
 * the caller's entitlements*, so a successful call with a plausible range
 * is the historical-access proof. Live entitlement cannot be probed this
 * way at all — that needs a live session, and it belongs with the live
 * provider work.
 */

const DATABENTO_HOST = "https://hist.databento.com";

/** CME Globex MDP 3.0 — the only dataset the cache uses. */
export const DEFAULT_DATASET = "GLBX.MDP3";

export interface DatasetRange {
  /** ISO timestamp of the earliest data the key may read. */
  start: string;
  /** ISO timestamp of the latest — the embargo boundary, not "now". */
  end: string;
}

export type ProbeFailureKind =
  | "config_missing"
  | "auth"
  | "entitlement"
  | "rate_limited"
  | "network"
  | "unknown";

export type DatabentoProbeResult =
  | { ok: true; dataset: string; range: DatasetRange; probedAt: string }
  | { ok: false; kind: ProbeFailureKind; message: string };

/** Carries the probe's own failure kind through a throw, so
 *  `classifyError` reads it instead of pattern-matching a message. */
export class DatabentoProbeError extends Error {
  readonly kind: ProbeFailureKind;

  constructor(kind: ProbeFailureKind, message: string) {
    super(message);
    this.name = "DatabentoProbeError";
    this.kind = kind;
  }
}

function basicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

/**
 * Pull `{ start, end }` out of a `metadata.get_dataset_range` body.
 *
 * Returns null on any other shape rather than coercing. Databento's
 * documented response is a flat `{"start": …, "end": …}`, but this is the
 * one call in the probe path nobody here has run against a live key yet —
 * a null return surfaces the raw body in the probe message, which is how
 * the real shape gets captured instead of guessed.
 */
export function parseDatasetRange(body: string): DatasetRange | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(o, "start")) return null;
  if (!Object.prototype.hasOwnProperty.call(o, "end")) return null;
  if (typeof o.start !== "string" || typeof o.end !== "string") return null;
  if (o.start.length === 0 || o.end.length === 0) return null;
  return { start: o.start, end: o.end };
}

/** HTTP status → probe failure kind. 403 is the entitlement signal; 401 is
 *  a bad key. The two are worth distinguishing because the operator's next
 *  action differs — upgrade the plan versus fix the credential. */
export function probeFailureKindForStatus(status: number): ProbeFailureKind {
  if (status === 401) return "auth";
  if (status === 403 || status === 422) return "entitlement";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "network";
  return "unknown";
}

/**
 * Probe historical entitlement for `dataset`. Never throws — every failure
 * comes back as `{ ok: false }` with the gateway's own error text, because
 * the caller's job is to display it, not to catch it.
 */
export async function probeHistoricalEntitlement(
  apiKey: string | null,
  dataset: string = DEFAULT_DATASET,
): Promise<DatabentoProbeResult> {
  if (!apiKey) {
    return {
      ok: false,
      kind: "config_missing",
      message:
        "No Databento API key configured — enter one in Settings, or set DATABENTO_API_KEY.",
    };
  }

  const url = `${DATABENTO_HOST}/v0/metadata.get_dataset_range?dataset=${encodeURIComponent(dataset)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: basicAuthHeader(apiKey) } });
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `Couldn't reach Databento — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const body = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      kind: probeFailureKindForStatus(res.status),
      message: `Databento ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
    };
  }

  const range = parseDatasetRange(body);
  if (!range) {
    return {
      ok: false,
      kind: "unknown",
      message: `Databento returned an unrecognised dataset-range shape: ${body.slice(0, 500)}`,
    };
  }

  return { ok: true, dataset, range, probedAt: new Date().toISOString() };
}
