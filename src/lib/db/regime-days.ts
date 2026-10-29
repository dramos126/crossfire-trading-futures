import { getDb, registerMigration } from "./connection";
import {
  CLASSIFIER_VERSION,
  UNKNOWN_LABEL,
  type RangeAxis,
  type RegimeFeatures,
  type RegimeResult,
  type VolTier,
} from "@/lib/trading/regime/classify-regime";

/**
 * One row per (instrument, session day, classifier version): the day-ahead
 * regime label, the features it was computed from, and when.
 *
 * **It is a record, not a cache.** Nothing downstream recomputes a label a
 * trade was stamped under — the trade row carries its own copy of the label
 * and the version, and a `classifier_version = "2"` recompute inserts rows
 * *beside* v1's rather than over them. That is what makes a persisted label
 * and a recomputed one comparable, which is the whole reason the version is
 * in the key. See `docs/modules/trading/regime.md`.
 *
 * Written by two paths with one implementation — the nightly job during the
 * CME maintenance break and the lazy fill at a session day's first evaluation
 * ([engine-regime.ts](../trading/engine/engine-regime.ts)). Read at entry, by
 * `GET /api/regime`, and by nothing that decides whether to trade: phase 2
 * observes the label and does not obey it.
 */
registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS regime_days (
      ticker             TEXT NOT NULL,
      session_date       TEXT NOT NULL,
      classifier_version TEXT NOT NULL,
      label              TEXT NOT NULL,
      features_json      TEXT,
      computed_at        TEXT NOT NULL,
      source             TEXT NOT NULL,
      PRIMARY KEY (ticker, session_date, classifier_version)
    );
    -- "what were tonight's labels" — the board chip and the Discord line both
    -- ask across tickers for one session day.
    CREATE INDEX IF NOT EXISTS idx_regime_days_session
      ON regime_days(session_date, classifier_version);
  `);
});

/** Which path last wrote the row, which is not the same as which paths tried:
 *  a nightly `unknown` healed lazily reads `lazy` afterwards. "Did the nightly
 *  job run" is a soak question and this is a hint at it; the `regime_labelled`
 *  event is the record. */
export type RegimeDaySource = "nightly" | "lazy";

export interface RegimeDay {
  ticker: string;
  sessionDate: string;
  classifierVersion: string;
  label: string;
  /** `null` exactly when the label is `unknown` — a partial feature set is a
   *  number someone reads as a measurement. */
  features: RegimeFeatures | null;
  /** Derived from `label`, not stored: the pair *is* the label. */
  vol: VolTier | null;
  range: RangeAxis | null;
  computedAt: string;
  source: RegimeDaySource;
}

interface DbRow {
  ticker: string;
  session_date: string;
  classifier_version: string;
  label: string;
  features_json: string | null;
  computed_at: string;
  source: string;
}

/**
 * Persist one day's label.
 *
 * **The only permitted overwrite is an `unknown` row being healed.** A row
 * already carrying a real label is settled: same version, same classifier,
 * same bars means the same answer, so a differing recompute means the bar
 * data moved underneath it — and silently rewriting a label trades were
 * stamped against is worse than keeping the first one. An `unknown`, on the
 * other hand, is the fail-closed answer to a window the fetch could not fill,
 * and it exists to be replaced once the bars are there.
 */
export function upsertRegimeDay(day: {
  ticker: string;
  sessionDate: string;
  result: RegimeResult;
  source: RegimeDaySource;
}): void {
  getDb()
    .prepare(
      `INSERT INTO regime_days
         (ticker, session_date, classifier_version, label, features_json, computed_at, source)
       VALUES (@ticker, @sessionDate, @classifierVersion, @label, @featuresJson, @computedAt, @source)
       ON CONFLICT(ticker, session_date, classifier_version) DO UPDATE SET
         label         = excluded.label,
         features_json = excluded.features_json,
         computed_at   = excluded.computed_at,
         source        = excluded.source
       WHERE regime_days.label = @unknown AND excluded.label <> @unknown`,
    )
    .run({
      ticker: day.ticker,
      sessionDate: day.sessionDate,
      classifierVersion: day.result.classifierVersion,
      label: day.result.label,
      featuresJson: day.result.features == null ? null : JSON.stringify(day.result.features),
      computedAt: new Date().toISOString(),
      source: day.source,
      unknown: UNKNOWN_LABEL,
    });
}

export function getRegimeDay(
  ticker: string,
  sessionDate: string,
  classifierVersion: string = CLASSIFIER_VERSION,
): RegimeDay | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM regime_days
        WHERE ticker = ? AND session_date = ? AND classifier_version = ?`,
    )
    .get(ticker, sessionDate, classifierVersion) as DbRow | undefined;
  return row == null ? null : rowToRegimeDay(row);
}

/** Every ticker's label for one session day, under one classifier version. */
export function listRegimeDaysForSession(
  sessionDate: string,
  classifierVersion: string = CLASSIFIER_VERSION,
): RegimeDay[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM regime_days
        WHERE session_date = ? AND classifier_version = ?
        ORDER BY ticker ASC`,
    )
    .all(sessionDate, classifierVersion) as DbRow[];
  return rows.map(rowToRegimeDay);
}

function rowToRegimeDay(r: DbRow): RegimeDay {
  const [vol, range] = splitLabel(r.label);
  return {
    ticker: r.ticker,
    sessionDate: r.session_date,
    classifierVersion: r.classifier_version,
    label: r.label,
    features: parseFeatures(r.features_json),
    vol,
    range,
    computedAt: r.computed_at,
    source: r.source === "nightly" ? "nightly" : "lazy",
  };
}

const VOL_TIERS: readonly string[] = ["quiet", "normal", "active"];
const RANGE_AXES: readonly string[] = ["compressed", "expanded"];

/** `"<vol>.<range>"` back into its two axes. `unknown` and anything the
 *  vocabulary does not carry read as no axes rather than as invented ones. */
function splitLabel(label: string): [VolTier | null, RangeAxis | null] {
  const [vol, range] = label.split(".");
  if (!VOL_TIERS.includes(vol) || !RANGE_AXES.includes(range)) return [null, null];
  return [vol as VolTier, range as RangeAxis];
}

/**
 * The feature blob, narrowed rather than asserted — this is a TEXT column on
 * a mounted volume and every field is a number a surface prints. A blob
 * missing any of the four reads as no features, which is the same answer an
 * `unknown` row gives, rather than as a partial measurement.
 */
function parseFeatures(raw: string | null): RegimeFeatures | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const blob = parsed as Record<string, unknown>;
  const { vol5, vol5Pct, rthRange, rangeRatio } = blob;
  if (
    typeof vol5 !== "number" ||
    typeof vol5Pct !== "number" ||
    typeof rthRange !== "number" ||
    typeof rangeRatio !== "number"
  ) {
    return null;
  }
  return { vol5, vol5Pct, rthRange, rangeRatio };
}
