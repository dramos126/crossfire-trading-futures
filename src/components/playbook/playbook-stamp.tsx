import {
  NO_BOOK_STAMP,
  NO_BOOK_TITLE,
  TEST_STRATEGY_REASON,
  type AdmissionStamp,
} from "@/components/playbook/playbook-detail-model";

/**
 * `TEST FIXTURE` — stamped from `isTest`, never derived from the key.
 *
 * One markup for the two places it renders on the detail page, the header and
 * the Deploy confirmation, so the confirmation cannot carry a quieter version
 * of the stamp the header shows.
 */
export function TestFixtureStamp() {
  return (
    <span
      title={TEST_STRATEGY_REASON}
      className="shrink-0 rounded-full border border-[var(--danger)]/30 bg-[var(--danger)]/15 px-1 py-0.5 text-[10px] uppercase tracking-wide text-[var(--danger)]"
    >
      test fixture
    </span>
  );
}

/**
 * `ADMITTED` / `CANDIDATE` / `RETIRED` — a stamp, not a status chip.
 *
 * It reuses no rung of `deriveDeploymentStatus`: that ladder is about a
 * deployment the engine is or is not running, and this is a property of a
 * playbook that may be running on four books at once or on none.
 *
 * **No green.** On this surface green would claim the engine is doing
 * something, which is the board's vocabulary and not this one's — so an
 * admitted playbook stamps at full foreground contrast, a candidate takes the
 * `warn` tone and a retired one recedes.
 *
 * A `FieldBadge`'s footprint and border, with a tone: that primitive carries
 * one colour for every caller, and the three tones are the whole point here.
 */

const TONE_CLASS: Record<AdmissionStamp["tone"], string> = {
  strong: "border-[var(--card-border)] bg-[var(--bg)] text-[var(--foreground)]",
  warn: "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]",
  muted: "border-[var(--card-border)] bg-[var(--bg)] text-[var(--muted-secondary)]",
};

const STAMP_CLASS =
  "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide";

export function AdmissionStampBadge({ stamp }: { stamp: AdmissionStamp }) {
  return (
    <span title={stamp.title} className={`${STAMP_CLASS} ${TONE_CLASS[stamp.tone]}`}>
      {stamp.label}
    </span>
  );
}

/**
 * `IN NO BOOK` — the admission stamp's footprint in its muted tone, because
 * it is a standing property of the playbook and information, not a warning.
 * One markup for the list row and the detail header.
 */
export function NoBookStamp() {
  return (
    <span title={NO_BOOK_TITLE} className={`${STAMP_CLASS} ${TONE_CLASS.muted}`}>
      {NO_BOOK_STAMP}
    </span>
  );
}
