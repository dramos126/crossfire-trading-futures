"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { IntentBadges } from "@/components/intent-badges";
import { AdmissionStampBadge, NoBookStamp } from "@/components/playbook/playbook-stamp";
import {
  buildPlaybookHeaders,
  describeFiltering,
  filterPlaybooks,
  TEST_STRATEGY_REASON,
  type AdmittedFilter,
  type PlaybookHeader,
} from "@/components/playbook/playbook-detail-model";
import { listStrategies } from "@/lib/trading/strategies";

/**
 * `/playbooks` — the reading surface. *What can this platform trade, and what
 * is each one for?*
 *
 * The shipped strategies list's rules, verbatim: full-width zebra-striped
 * rows, a row is a `Link` so middle-click and browser-back come for free,
 * filter first and search second, an emptied list says how many it is hiding,
 * the intent badge sits beside the name through `IntentBadges`, and a test
 * fixture is **stamped from `isTest`, never derived from the key**.
 *
 * What it does not carry is anything about what is running: no deploy count,
 * no pulse dot, no Deploy button. A green dot here would claim the engine
 * will take an entry, and this page knows nothing about accounts — arming a
 * playbook happens on the Books screen.
 *
 * Every decision lives in
 * [`playbook-detail-model.ts`](./playbook-detail-model.ts).
 */

const CHIP =
  "px-2 py-0.5 rounded-sm text-[10px] uppercase tracking-wide text-[var(--muted)] bg-[var(--background)] border border-[var(--card-border)]";

const FILTER_LABELS: Record<AdmittedFilter, string> = {
  all: "All",
  admitted: "Admitted",
  "not-admitted": "Not admitted",
};

export function PlaybookList() {
  const [query, setQuery] = useState("");
  const [admitted, setAdmitted] = useState<AdmittedFilter>("all");

  const rows = useMemo(() => buildPlaybookHeaders(listStrategies()), []);
  const shown = useMemo(() => filterPlaybooks(rows, { query, admitted }), [rows, query, admitted]);
  const filterNote = describeFiltering(rows.length, shown.length);

  if (rows.length === 0) {
    return (
      <div className="border border-[var(--card-border)] bg-[var(--card)] p-8 text-center">
        <p className="mb-2 text-[var(--muted)]">No playbooks are installed.</p>
        <p className="text-[11px] text-[var(--muted)]">
          A playbook is a strategy module in this build — one instrument, one session, its
          numbers fixed in code.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Filter by admission">
          {(["all", "admitted", "not-admitted"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={admitted === value}
              onClick={() => setAdmitted(value)}
              className={`rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest transition-colors ${
                admitted === value
                  ? "border-[var(--accent)]/40 bg-[var(--accent)]/15 text-[var(--accent)]"
                  : "border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {FILTER_LABELS[value]}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, key or description"
          aria-label="Search playbooks"
          className="min-h-11 min-w-[16rem] flex-1 rounded-md sm:min-h-0 border border-[var(--card-border)] bg-[var(--background)] px-3 py-1 text-xs text-[var(--foreground)]"
        />
        {filterNote && (
          <span className="shrink-0 font-mono tabular text-[11px] text-[var(--muted)]">
            {filterNote}
          </span>
        )}
      </div>

      <div className="divide-y divide-[var(--card-border)] border border-[var(--card-border)]">
        {shown.map((row, idx) => (
          <PlaybookRowLink key={row.key} row={row} idx={idx} />
        ))}
        {shown.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-[var(--muted)]">
            Nothing matches. Clear the filter or search to see all {rows.length}.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Below `sm` the row restacks for reading on a phone: the name alone, then one
 * line of chips and stamps, then the description at a readable size. From `sm`
 * up the desk row renders as before — the phone line is `sm:hidden`, and the
 * desk title line's extras and chip line are `hidden sm:…`.
 */
function PlaybookRowLink({ row, idx }: { row: PlaybookHeader; idx: number }) {
  const zebra = idx % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]";
  const chips = (
    <>
      {row.instrument && <span className={CHIP}>{row.instrument}</span>}
      <span className={CHIP}>{row.timeframeLabel}</span>
      <span className={CHIP}>{row.sessionLabel}</span>
    </>
  );
  const testStamp = row.isTest && (
    <span
      title={TEST_STRATEGY_REASON}
      className="shrink-0 rounded-full border border-[var(--danger)]/30 bg-[var(--danger)]/15 px-1 py-0.5 text-[10px] uppercase tracking-wide text-[var(--danger)]"
    >
      test fixture
    </span>
  );
  const minimumRisk = row.minimumRisk && (
    <span title={row.minimumRisk.text} className={`cursor-help ${CHIP}`}>
      {row.minimumRisk.stamp}
    </span>
  );
  return (
    <Link
      href={`/playbooks/${encodeURIComponent(row.key)}`}
      className={`block px-4 py-3 transition-colors hover:bg-[var(--hover)] ${zebra}`}
    >
      <div className="flex items-baseline gap-2">
        {/* Entity tier: a playbook titles its own row. */}
        <h3 className="text-base font-semibold text-[var(--foreground)]">{row.name}</h3>
        {/* The search still matches the key; a phone has no width for it. */}
        <span className="hidden font-mono tabular text-[11px] text-[var(--muted-secondary)] sm:inline">
          {row.key}
        </span>
        <span className="hidden sm:contents">
          <IntentBadges intent={row.intent} />
          {testStamp}
          {row.inNoBook && <NoBookStamp />}
          {/* A playbook that declares no admission stamps nothing — no
              placeholder, for the reason an unlabelled module gets no intent
              badge. */}
          {row.stamp && (
            <span className="ml-auto">
              <AdmissionStampBadge stamp={row.stamp} />
            </span>
          )}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1 sm:hidden">
        {chips}
        <IntentBadges intent={row.intent} />
        {row.stamp && <AdmissionStampBadge stamp={row.stamp} />}
        {testStamp}
        {row.inNoBook && <NoBookStamp />}
        {minimumRisk}
      </div>

      {row.description && (
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)] sm:mt-1 sm:text-xs">
          {row.description}
        </p>
      )}

      <div className="mt-2 hidden flex-wrap gap-1 sm:flex">
        {chips}
        {minimumRisk}
      </div>
    </Link>
  );
}
