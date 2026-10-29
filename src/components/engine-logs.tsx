"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { subscribeLogLines } from "@/lib/hooks/log-line-feed";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";
import type { WireLogRecord } from "@/lib/logging/pipe";
import type { Severity } from "@/lib/logging/vocabulary";
import { statusToneClass } from "./deployment/deployment-status";
import {
  activityTime,
  appendLogLine,
  buildActivityFeed,
  mergeLogBuckets,
  presentSeverity,
  presentTime,
  type ActivityEpisode,
  type ActivityItem,
  type ActivityLine,
  type SeverityPresentation,
} from "./log-activity";
import {
  DEFAULT_FACET_STATE,
  applyFacets,
  buildFacets,
  clearFacetDimension,
  scopeToDeployments,
  toggleFacet,
  type DeploymentScope,
  type FacetDimension,
  type FacetOption,
  type FacetState,
} from "./log-facets";

/**
 * The `/logs` viewer — two lanes over one fetched payload and the lines the
 * stream pushes after it.
 *
 * **Activity** is the lane a non-technical reader gets: plain sentences from
 * the event vocabulary, trades as one card, relative time. **Diagnostics** is
 * the full stream with the envelope visible and three facet dimensions,
 * replacing the seven exclusive chips the operator called *"busy and not
 * great for filtering"*.
 *
 * This file wires classes, keys and `title=` and holds no logic — the
 * decisions live in `log-activity.ts` and `log-facets.ts`, which are plain
 * `.ts` and tested. See docs/modules/ui/design-language.md.
 */

type Lane = "activity" | "diagnostics";

const LANES: readonly { id: Lane; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "diagnostics", label: "Diagnostics" },
];

const PER_RING_LIMITS = [25, 50, 100, 500] as const;
type PerRingLimit = (typeof PER_RING_LIMITS)[number];
const DEFAULT_LIMIT: PerRingLimit = 100;
/** The re-read's cadence while the stream is down and pushes nothing. */
export const LOGS_FALLBACK_MS = 5_000;
/** How often `2m ago` advances — the cadence it had when a poll drove it. */
const RELATIVE_TIME_TICK_MS = 5_000;

// Namespaced so the future Settings page can read or migrate these without
// colliding. The facet state is deliberately absent: a filter that outlives
// the session is how a line that was present read as absent and sent a whole
// diagnosis down the wrong path.
const LIMIT_STORAGE_KEY = "engineLogs.perRingLimit";
const LANE_STORAGE_KEY = "engineLogs.lane";

function loadStoredLimit(): PerRingLimit {
  if (typeof window === "undefined") return DEFAULT_LIMIT;
  const raw = window.localStorage.getItem(LIMIT_STORAGE_KEY);
  const n = raw == null ? NaN : Number(raw);
  return (PER_RING_LIMITS as readonly number[]).includes(n) ? (n as PerRingLimit) : DEFAULT_LIMIT;
}

function loadStoredLane(): Lane {
  if (typeof window === "undefined") return "activity";
  return window.localStorage.getItem(LANE_STORAGE_KEY) === "diagnostics" ? "diagnostics" : "activity";
}

/** `× 23` — what a folded burst reads as. Null below two, because every
 *  uncollapsed line would otherwise carry a `× 1` that says nothing. */
function BurstBadge({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <span
      className="ml-2 inline-block rounded-sm border border-[var(--card-border)] bg-[var(--background)] px-1 py-px font-mono text-[10px] tabular text-[var(--warning)]"
      title={`${count} identical lines were folded into this one`}
    >
      × {count}
    </span>
  );
}

/**
 * *Needs attention* / *FYI*, on the deployment ladder's tone map.
 *
 * **One tone map on this page.** The technical rung stays reachable through
 * the tooltip and is the Diagnostics lane's whole `Sev` column, so nothing is
 * lost by the Activity lane asking one question instead of four.
 */
function AttentionPill({
  attention,
  severity,
}: {
  attention: SeverityPresentation;
  severity: Severity;
}) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] font-medium uppercase tracking-wider ${statusToneClass(attention.tone)}`}
      title={`Severity: ${severity}`}
    >
      {attention.label}
    </span>
  );
}

/**
 * @param deploymentIds `?deployment=` — narrow every lane to a named set of
 * deployments. Empty is the whole stream.
 */
export function EngineLogs({
  deploymentIds = [],
}: {
  deploymentIds?: readonly string[];
}) {
  const { token, live } = useTrading();
  const [allLogs, setAllLogs] = useState<WireLogRecord[]>([]);
  // Lines pushed while a read is out: the read's snapshot may predate them,
  // so they are folded onto its answer. Null while no read is out.
  const pushedDuringReadRef = useRef<WireLogRecord[] | null>(null);
  // Two reads can overlap (a reconnect read beside a fallback tick, a cap
  // change). Only the newest applies: an older answer landing last would
  // overwrite the newer snapshot and the lines pushed on top of it.
  const logReadsAskedRef = useRef(0);
  const [lane, setLane] = useState<Lane>(() => loadStoredLane());
  const [facets, setFacets] = useState<FacetState>(DEFAULT_FACET_STATE);
  const [perRingLimit, setPerRingLimit] = useState<PerRingLimit>(() => loadStoredLimit());
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  // `2m ago` needs a clock. Rows no longer arrive on a timer, so it has its
  // own.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setSearchQuery(searchInput), 150);
    return () => clearTimeout(id);
  }, [searchInput]);

  const fetchLogs = useCallback(async () => {
    if (!token) return;
    const ask = ++logReadsAskedRef.current;
    const pushedDuringRead: WireLogRecord[] = [];
    pushedDuringReadRef.current = pushedDuringRead;
    try {
      const res = await fetch("/api/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logs", limit: perRingLimit }),
      });
      const data = await res.json();
      if (res.ok && ask === logReadsAskedRef.current) {
        // The server returns one bucket per legacy level, each capped to
        // perRingLimit — which is what keeps a low-frequency level visible
        // at a small cap. The lanes below face severity and category, so
        // the buckets are merged straight back into one stream, ordered on
        // `(timestamp, seq)` — see `mergeLogBuckets`.
        const byLevel: Record<string, WireLogRecord[]> = data.byLevel ?? {};
        setAllLogs(
          pushedDuringRead.reduce(
            (records, line) => appendLogLine(records, line, perRingLimit),
            mergeLogBuckets(byLevel),
          ),
        );
        setNowMs(Date.now());
      }
    } catch {
      // ignore transient fetch errors — the next read reflects server state
    } finally {
      if (pushedDuringReadRef.current === pushedDuringRead) pushedDuringReadRef.current = null;
    }
  }, [token, perRingLimit]);

  // Read once, and again each time the stream comes back — what was pushed
  // while it was down is gone. Re-read on a timer only while it is down.
  useEffect(() => {
    if (!token) return;
    void fetchLogs();
    if (live) return;
    const id = setInterval(() => void fetchLogs(), LOGS_FALLBACK_MS);
    return () => clearInterval(id);
  }, [token, live, fetchLogs]);

  useEffect(
    () =>
      subscribeLogLines((line) => {
        pushedDuringReadRef.current?.push(line);
        setAllLogs((records) => appendLogLine(records, line, perRingLimit));
      }),
    [perRingLimit],
  );

  const handleLaneChange = (next: Lane) => {
    setLane(next);
    if (typeof window !== "undefined") window.localStorage.setItem(LANE_STORAGE_KEY, next);
  };

  const handleLimitChange = (next: PerRingLimit) => {
    setPerRingLimit(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LIMIT_STORAGE_KEY, String(next));
    }
  };

  const handleClear = async () => {
    if (!token) return;
    // A blocking confirm, which the design language reserves for exactly
    // this: the durable record goes with it and nothing brings it back.
    if (
      typeof window !== "undefined" &&
      !window.confirm("Clear all engine logs (memory + persisted)? This cannot be undone.")
    ) {
      return;
    }
    try {
      const res = await fetch("/api/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clearLogs" }),
      });
      if (res.ok) {
        setAllLogs([]);
        fetchLogs();
      }
    } catch {
      // ignore — the next poll reflects server state
    }
  };

  // The scope lands before either lane, so both answer about the same set —
  // the facets are the Diagnostics lane's control alone and a preset there
  // would lapse silently on Activity.
  const scopeKey = JSON.stringify(deploymentIds);
  const scope = useMemo(
    // `scopeKey` rather than the array: a `searchParams.getAll` result is a
    // fresh array on every render, so the identity would never settle. The
    // key is only a dep — the ids go through unserialized, so no separator
    // has to be a character an id cannot contain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => scopeToDeployments(allLogs, deploymentIds),
    [allLogs, scopeKey],
  );
  const logs = scope?.records ?? allLogs;

  const facetOptions = useMemo(() => buildFacets(logs, facets), [logs, facets]);
  const diagnosticRows = useMemo(
    // `applyFacets` is a `filter`, so its result is already a fresh array.
    () => applyFacets(logs, facets, searchQuery).reverse(),
    [logs, facets, searchQuery],
  );
  const activityFeed = useMemo(
    () => buildActivityFeed(logs, { nowMs, query: searchQuery }),
    [logs, nowMs, searchQuery],
  );

  // Both counts, on both tabs. A reader on Activity can see that Diagnostics
  // is holding forty lines it is not showing them, which is the whole reason
  // the two-lane split is not a way of hiding things.
  const laneCounts: Record<Lane, number> = {
    activity: activityFeed.filter((item) => item.kind !== "day").length,
    diagnostics: diagnosticRows.length,
  };

  if (!token) {
    return (
      <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] p-6 text-center text-[var(--muted)]">
        Connect first to stream engine logs.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] p-4">
      {/* Context left, action right — the scan path the design language sets. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Log lane"
          className="inline-flex overflow-hidden rounded-md border border-[var(--card-border)]"
        >
          {LANES.map(({ id, label }) => {
            const active = lane === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={active}
                aria-controls="engine-logs-panel"
                onClick={() => handleLaneChange(id)}
                className={`px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                  active
                    ? "bg-[var(--bg-row)] text-[var(--accent)]"
                    : "bg-[var(--background)] text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {label}
                <span className="ml-1.5 font-mono text-[11px] tabular text-[var(--muted-secondary)]">
                  {laneCounts[id]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[var(--muted)]">
          <label htmlFor="engine-logs-search" className="sr-only">
            Search
          </label>
          <input
            id="engine-logs-search"
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search…"
            className="w-48 rounded-md border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 text-[var(--foreground)] normal-case tracking-normal"
          />
          <label htmlFor="engine-logs-limit">Show</label>
          <select
            id="engine-logs-limit"
            value={perRingLimit}
            onChange={(e) => handleLimitChange(Number(e.target.value) as PerRingLimit)}
            className="rounded-md border border-[var(--card-border)] bg-[var(--background)] px-1.5 py-1 font-mono tabular text-[var(--foreground)]"
            title="How many of the most recent lines to load for each kind of line — errors, warnings, trades, connection and heartbeat lines each get their own allowance. That is what keeps a rare error visible when the number is small."
          >
            {PER_RING_LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span>per kind</span>
          <button
            type="button"
            onClick={handleClear}
            className="ml-2 rounded-md border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 uppercase tracking-wider text-[var(--danger)] hover:bg-[var(--card)]"
            title="Clear all engine logs (memory + persisted DB)"
          >
            Clear
          </button>
        </div>
      </div>

      {scope && <ScopeBanner scope={scope} />}

      {lane === "diagnostics" && (
        <FacetBar
          options={facetOptions}
          onToggle={(dimension, value) => setFacets((prev) => toggleFacet(prev, dimension, value))}
          onClearDimension={(dimension) => setFacets((prev) => clearFacetDimension(prev, dimension))}
        />
      )}

      {/* Wide content scrolls here rather than pushing the page. The lane
          state that survives a switch — facets, search, cap — lives in the
          parent, so unmounting a lane costs nothing. */}
      <div
        id="engine-logs-panel"
        role="tabpanel"
        className="max-h-[70vh] overflow-auto rounded-md border border-[var(--card-border)] bg-[var(--background)]"
      >
        {lane === "activity" ? (
          <ActivityLane feed={activityFeed} total={logs.length} query={searchQuery} nowMs={nowMs} />
        ) : (
          <DiagnosticsLane rows={diagnosticRows} total={logs.length} nowMs={nowMs} />
        )}
      </div>
    </div>
  );
}

/**
 * What the `?deployment=` scope is hiding, and the way out of it.
 *
 * A filter the reader did not set has to say so on the surface it filters —
 * this viewer's one recorded way of misleading is a line that was present and
 * not shown. The escape is a link back to `/logs` rather than a button,
 * because the scope lives in the URL and clearing it means leaving the URL.
 */
function ScopeBanner({ scope }: { scope: DeploymentScope }) {
  const { text } = useDisplayPrivacy();
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-2 py-1.5 text-[11px]">
      <span className="uppercase tracking-wider text-[var(--muted-secondary)]">Scoped to</span>
      <span className="font-mono text-[var(--foreground)]" title={scope.ids.join("\n")}>
        {text(scope.label)}
      </span>
      <span className="text-[var(--muted)]">
        {scope.records.length === 0
          ? "— no lines for it in the loaded window"
          : `— ${scope.records.length} of the loaded lines`}
      </span>
      <Link href="/logs" className="ml-auto text-[var(--accent)] hover:underline">
        Show every deployment
      </Link>
    </div>
  );
}

// ── Facets ─────────────────────────────────────────────────────────────

const FACET_ROWS: readonly { dimension: FacetDimension; label: string }[] = [
  { dimension: "severity", label: "Severity" },
  { dimension: "category", label: "Category" },
  { dimension: "deployment", label: "Deployment" },
];

function FacetBar({
  options,
  onToggle,
  onClearDimension,
}: {
  options: Record<FacetDimension, FacetOption[]>;
  onToggle: (dimension: FacetDimension, value: string) => void;
  onClearDimension: (dimension: FacetDimension) => void;
}) {
  return (
    <div className="mb-3 rounded-md border border-[var(--card-border)] bg-[var(--background)]">
      {FACET_ROWS.map(({ dimension, label }, index) => (
        <div
          key={dimension}
          className={`flex items-start gap-2 px-2 py-1.5 ${
            index % 2 === 0 ? "bg-[var(--bg-row-alt)]" : "bg-[var(--bg-row)]"
          }`}
        >
          <button
            type="button"
            onClick={() => onClearDimension(dimension)}
            className="w-24 shrink-0 pt-0.5 text-left text-[10px] uppercase tracking-wider text-[var(--muted-secondary)] hover:text-[var(--accent)]"
            title={`Show every ${label.toLowerCase()}`}
          >
            {label}
          </button>
          <div className="flex flex-wrap gap-1">
            {options[dimension].length === 0 ? (
              <span className="text-[11px] text-[var(--muted-secondary)]">none yet</span>
            ) : (
              options[dimension].map((option) => (
                <FacetChip
                  key={option.value}
                  dimension={dimension}
                  option={option}
                  onToggle={() => onToggle(dimension, option.value)}
                />
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function FacetChip({
  dimension,
  option,
  onToggle,
}: {
  dimension: FacetDimension;
  option: FacetOption;
  onToggle: () => void;
}) {
  // Severity is the one dimension colour belongs on, so it reuses the status
  // tone map rather than growing a palette of its own.
  const enabledTone =
    dimension === "severity"
      ? statusToneClass(presentSeverity(option.value as Severity).tone)
      : "border-[var(--card-border)] bg-[var(--bg-row-deep)] text-[var(--foreground)]";
  // Severity and category are vocabulary, so they take the uppercase
  // structural stamp. A deployment's display name is **data** — uppercasing
  // `…4469-ema-crossover.MNQ` misstates the value the operator has to match
  // against — so it renders as written, in mono like every other identifier.
  const isVocabulary = dimension !== "deployment";
  const { text } = useDisplayPrivacy();
  const label = text(option.label);
  const hint = option.enabled ? `Hide ${label}` : `Show ${label}`;
  return (
    <button
      type="button"
      aria-pressed={option.enabled}
      onClick={onToggle}
      title={option.title == null ? hint : `${text(option.title)} — ${hint.toLowerCase()}`}
      className={`rounded-sm border px-1.5 py-px ${
        isVocabulary ? "text-[10px] uppercase tracking-wider" : "font-mono text-[11px]"
      } ${
        option.enabled
          ? enabledTone
          : "border-[var(--card-border)] bg-transparent text-[var(--muted-secondary)]"
      }`}
    >
      {label}
      <span className="ml-1 font-mono tabular">{option.count}</span>
    </button>
  );
}

// ── Diagnostics ────────────────────────────────────────────────────────

function DiagnosticsLane({
  rows,
  total,
  nowMs,
}: {
  rows: readonly WireLogRecord[];
  total: number;
  nowMs: number;
}) {
  const { text } = useDisplayPrivacy();
  if (rows.length === 0) {
    return (
      <p className="px-3 py-3 text-[11px] text-[var(--muted)]">
        {total === 0 ? "No engine activity yet." : "No lines match the current filters."}
      </p>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-[var(--card-border)] bg-[var(--card)] text-[10px] uppercase tracking-wider text-[var(--muted-secondary)]">
          {/* w-32 holds `Oct 27 09:31:12` at 12px mono with the cell's padding. */}
          <th className="w-32 px-2 py-1 text-left font-medium">Time</th>
          <th className="w-14 px-2 py-1 text-left font-medium">Sev</th>
          <th className="w-24 px-2 py-1 text-left font-medium">Category</th>
          <th className="w-56 px-2 py-1 text-left font-medium">Subject</th>
          <th className="w-48 px-2 py-1 text-left font-medium">Event</th>
          <th className="px-2 py-1 text-left font-medium">Message</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const time = presentTime(row.timestamp, nowMs);
          return (
            <tr
              key={`${row.timestamp}-${i}`}
              className={i % 2 === 0 ? "bg-[var(--bg-row-alt)]" : "bg-[var(--bg-row)]"}
            >
              <td
                className="whitespace-nowrap px-2 py-1 align-top font-mono tabular text-[var(--muted)]"
                title={time.absolute}
              >
                {time.stamp}
              </td>
              <td className="px-2 py-1 align-top">
                {/* The same tone map the Activity pill uses — one map on the
                    page, so WARN cannot be two different yellows. */}
                <span
                  className={`inline-block rounded-sm border px-1 py-px font-mono text-[10px] uppercase tracking-wider ${statusToneClass(presentSeverity(row.severity).tone)}`}
                >
                  {row.severity}
                </span>
              </td>
              <td className="px-2 py-1 align-top font-mono text-[var(--muted)]">{row.category}</td>
              <td
                className="px-2 py-1 align-top font-mono text-[var(--foreground)]"
                title={row.deploymentId}
              >
                {text(row.display ?? row.deploymentId)}
              </td>
              <td className="px-2 py-1 align-top font-mono text-[11px] text-[var(--muted-secondary)]">
                {row.event ?? "—"}
              </td>
              <td className="px-2 py-1 align-top font-mono break-words text-[var(--foreground)]">
                {text(row.message)}
                <BurstBadge count={row.burstCount} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Activity ───────────────────────────────────────────────────────────

/**
 * One column grid for every Activity line: time, severity pill,
 * subject, message. Each track is a fixed width, so a message starts at the
 * same x on every row.
 *
 * **The pill is what made this necessary.** It was a bare flex item sized to
 * its own label, and `Needs attention` is ~85px wider than `FYI` — so an
 * error row pushed its own subject and message that far right of the info
 * rows around it and the feed's left edges came out ragged.
 *
 * **The pill track is a fixed width, not `max-content`.** An intrinsic track
 * is measured against whatever the feed currently holds, so the first
 * needs-attention line to arrive on a 5s poll would shift every column on the
 * page — a terminal column may not move while it is being read. `8rem` clears
 * the wider of the two labels `presentSeverity` can return (`NEEDS ATTENTION`,
 * ~120px at 10px Inter Medium with `tracking-wider`), and the 8px gutter
 * absorbs the rest before anything could reach the subject column; a reworded
 * severity label wants this re-measured.
 *
 * The time track is sized for the dated form `Oct 27 09:31` (~80px at 11px
 * mono), the widest thing `activityTime` returns.
 */
const ACTIVITY_GRID = "grid grid-cols-[5.25rem_8rem_13rem_minmax(0,1fr)] items-baseline gap-x-2";

/** The same tracks inside an episode card, minus the subject column — the
 *  card's title is the subject for every line under it. The pill cell is
 *  rendered even on the lines that carry no pill, so the sentences align
 *  down the card rather than indenting off the one line that needs attention. */
const EPISODE_GRID = "grid grid-cols-[5.25rem_8rem_minmax(0,1fr)] items-baseline gap-x-2";

function ActivityLane({
  feed,
  total,
  query,
  nowMs,
}: {
  feed: readonly ActivityItem[];
  total: number;
  query: string;
  nowMs: number;
}) {
  if (feed.length === 0) {
    return (
      <p className="px-3 py-3 text-[11px] text-[var(--muted)]">
        {total === 0 || query.length === 0 ? "No engine activity yet." : "Nothing matches that search."}
      </p>
    );
  }
  // Zebra counts content rows only, so a day divider does not shift the
  // banding of everything after it.
  let band = 0;
  return (
    <div>
      {feed.map((item) => {
        if (item.kind === "day") {
          band = 0;
          return (
            <div
              key={item.key}
              className="flex items-center gap-2 border-y border-[var(--card-border)] bg-[var(--card)] px-2 py-1 text-[10px] uppercase tracking-widest text-[var(--muted-secondary)]"
            >
              {item.label}
            </div>
          );
        }
        const zebra = band++ % 2 === 0 ? "bg-[var(--bg-row-alt)]" : "bg-[var(--bg-row)]";
        return item.kind === "episode" ? (
          <EpisodeCard key={item.key} episode={item.episode} className={zebra} nowMs={nowMs} />
        ) : (
          <ActivityRow key={item.key} line={item.line} className={zebra} nowMs={nowMs} />
        );
      })}
    </div>
  );
}

function ActivityRow({
  line,
  className,
  nowMs,
}: {
  line: ActivityLine;
  className: string;
  nowMs: number;
}) {
  const { text } = useDisplayPrivacy();
  return (
    <div className={`${ACTIVITY_GRID} px-2 py-1.5 ${className}`}>
      <span
        className="font-mono tabular text-[11px] text-[var(--muted-secondary)]"
        title={line.time.absolute}
      >
        {activityTime(line.time, nowMs)}
      </span>
      {/* The cell is the track; the pill keeps its own width inside it. */}
      <span>
        <AttentionPill attention={line.attention} severity={line.severity} />
      </span>
      <span
        className="truncate font-mono text-[11px] text-[var(--muted)]"
        title={text(line.subject.title)}
      >
        {text(line.subject.label)}
      </span>
      <span className="min-w-0 text-xs text-[var(--foreground)]">
        {text(line.sentence.text)}
        <BurstBadge count={line.burstCount} />
      </span>
    </div>
  );
}

function EpisodeCard({
  episode,
  className,
  nowMs,
}: {
  episode: ActivityEpisode;
  className: string;
  nowMs: number;
}) {
  const { text } = useDisplayPrivacy();
  return (
    // The rail is structural, not chromatic. `--accent-blue` is the chart
    // marker taxonomy's entry colour and stays there; a card that reads as a
    // unit from its rail, its indent and its semibold subject needs no colour
    // of its own, and borrowing a taxonomy token is how a taxonomy stops
    // meaning one thing.
    <div className={`border-l-2 border-[var(--card-border)] px-2 py-1.5 ${className}`}>
      <div className={EPISODE_GRID}>
        <span
          className="font-mono tabular text-[11px] text-[var(--muted-secondary)]"
          title={episode.latest.absolute}
        >
          {activityTime(episode.latest, nowMs)}
        </span>
        <span>
          <AttentionPill attention={episode.attention} severity={episode.worst} />
        </span>
        {/* One cell, so the title cluster starts on the same track a
            standalone row's subject does instead of riding the pill. */}
        <div className="flex min-w-0 flex-wrap items-baseline gap-2">
          {/* The card's title is an entity name, so it takes the entity tier
              and semibold — not body size, per the typography rule. */}
          <span
            className="font-mono text-base font-semibold text-[var(--foreground)]"
            title={text(episode.subject.title)}
          >
            {text(episode.subject.label)}
          </span>
          <span className="font-mono tabular text-[11px] text-[var(--muted-secondary)]">
            trade #{episode.tradeId}
          </span>
          {episode.span != null && (
            <span
              className="font-mono tabular text-[11px] text-[var(--muted-secondary)]"
              title={`Opened ${episode.opened.absolute}`}
            >
              {episode.span}
            </span>
          )}
        </div>
      </div>
      {/* Zebra inside the card too — it is a list, and the rule has no
          exceptions. The card's own band is one of these two values, so half
          the rows read flush with it and the striping stays quiet. */}
      <ol className="mt-1 border-l border-[var(--card-border)] pl-2">
        {episode.lines.map((line, i) => (
          <li
            key={line.key}
            className={`${EPISODE_GRID} px-1 py-px ${
              i % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"
            }`}
          >
            <span
              className="font-mono tabular text-[11px] text-[var(--muted-secondary)]"
              title={line.time.absolute}
            >
              {line.time.clock}
            </span>
            {/* Only the lines that need attention wear a pill, so the one
                the card's header is warning about is findable inside it —
                but the cell stays, or the sentences below it would step
                left and the card would read as ragged as the feed did. */}
            <span>
              {line.attention.level === "attention" && (
                <AttentionPill attention={line.attention} severity={line.severity} />
              )}
            </span>
            <span className="min-w-0 text-[11px] text-[var(--foreground)]">
              {text(line.sentence.text)}
              <BurstBadge count={line.burstCount} />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
