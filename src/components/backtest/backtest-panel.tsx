"use client";

import type { BacktestResponse, BacktestProgress } from "@/lib/hooks/use-backtest-runner";

/**
 * The in-browser run's progress bar and summary, shared with the Playbook
 * page's *Try settings*. The panel that also held dates, presets, a starting
 * balance and a trade table went with the Strategies page; *Try settings*
 * reads the trades through the run reader instead.
 */

// ── Progress ────────────────────────────────────────────────────────

export function BacktestProgressBar({ progress }: { progress: BacktestProgress | null }) {
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.max(0, (progress.processed / progress.total) * 100))
      : 0;
  const label = progress
    ? `Processing bars… ${pct.toFixed(0)}% (${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()})`
    : "Fetching bars — standby";

  return (
    <div className="rounded-md bg-[var(--background)] border border-[var(--card-border)] px-3 py-2 space-y-2">
      <p className="text-xs text-[var(--muted)] tabular-nums">{label}</p>
      <div className="h-1.5 w-full rounded-sm bg-[var(--card)] overflow-hidden">
        <div
          className={`h-full bg-[var(--success)] transition-[width] duration-200 ease-out ${progress ? "" : "animate-pulse"}`}
          style={{ width: progress ? `${pct}%` : "100%" }}
        />
      </div>
    </div>
  );
}

// ── Results ─────────────────────────────────────────────────────────

/**
 * A run's warnings, its stats grid and its contract-coverage notices. *Try
 * settings* reads the trades through the run reader rather than through a
 * table here.
 */
export function BacktestSummary({ response }: { response: BacktestResponse }) {
  const { stats, warnings } = response.result;
  return (
    <div className="space-y-4">
      {warnings && warnings.length > 0 && (
        <div className="rounded-md border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)] space-y-1">
          {warnings.map((w, i) => (
            <p key={i}>⚠ {w}</p>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Stat label="Trades" value={stats.totalTrades.toString()} />
        <Stat
          label="Win Rate"
          value={`${(stats.winRate * 100).toFixed(1)}%`}
          color={stats.winRate >= 0.5 ? "success" : "danger"}
        />
        <Stat
          label={response.includeFees ? "Net P&L (after fees)" : "Net P&L (gross)"}
          value={formatDollars(stats.totalPnlDollars)}
          color={stats.totalPnlDollars >= 0 ? "success" : "danger"}
        />
        <Stat
          label={
            response.includeFees
              ? `Fees @ $${response.feePerSideUsd.toFixed(2)}/side`
              : "Fees (disabled)"
          }
          value={
            response.includeFees ? formatDollars(-stats.totalFeesDollars) : formatDollars(0)
          }
          color={response.includeFees ? "danger" : undefined}
        />
        <Stat
          label="Profit Factor"
          value={stats.profitFactor == null || stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}
        />
        <Stat
          label="Max Drawdown"
          value={formatDollars(-stats.maxDrawdownDollars)}
          color="danger"
        />
        <Stat label="Avg Win" value={`${stats.avgWinTicks.toFixed(1)}t`} color="success" />
        <Stat label="Avg Loss" value={`${stats.avgLossTicks.toFixed(1)}t`} color="danger" />
        <Stat label="Largest Win" value={`${Math.round(stats.largestWinTicks)}t`} />
        <Stat label="Largest Loss" value={`${Math.round(stats.largestLossTicks)}t`} />
        <Stat label="Wins / Losses / BE" value={`${stats.wins} / ${stats.losses} / ${stats.breakEven}`} />
        {response.actualRange && (
          <Stat
            label="Range"
            value={`${formatShortDate(response.actualRange.from)} → ${formatShortDate(response.actualRange.to)}`}
          />
        )}
      </div>

      {response.contractsUsed && response.contractsUsed.length > 1 && !response.truncated && (
        <div className="rounded-md bg-[var(--card)] border border-[var(--card-border)] border-l-2 border-l-[var(--accent)] text-xs text-[var(--muted)] px-3 py-2">
          Using {response.contractsUsed.length} contracts:{" "}
          {response.contractsUsed
            .map((c) => `${c.name} (from ${c.firstBar ? formatMonthSpan(c.firstBar) : "?"})`)
            .join(" · ")}
        </div>
      )}

      {response.truncated && (
        <div className="rounded-md bg-[var(--warning)]/10 border border-[var(--warning)]/30 text-[var(--warning)] text-xs px-3 py-2">
          {(() => {
            const requested = new Date(response.requestedRange.from);
            const actual = response.actualRange ? new Date(response.actualRange.from) : null;
            const daysDiff = actual
              ? Math.round((actual.getTime() - requested.getTime()) / 86_400_000)
              : null;
            const contractCount = response.contractsUsed?.length ?? 0;
            return (
              <>
                Earliest data: {actual ? formatDateOnly(response.actualRange!.from) : "unknown"}
                {daysDiff != null && daysDiff > 0 && (
                  <> · {daysDiff} day{daysDiff !== 1 ? "s" : ""} before your requested start</>
                )}
                .
                {contractCount > 1 && (
                  <> Rolled back through {contractCount} contract{contractCount !== 1 ? "s" : ""} to extend coverage.</>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: "success" | "danger";
}) {
  const colorClass =
    color === "success"
      ? "text-[var(--success)]"
      : color === "danger"
      ? "text-[var(--danger)]"
      : "";
  return (
    <div className="rounded-sm bg-[var(--background)] border border-[var(--card-border)] px-3 py-2">
      <p className="text-xs text-[var(--muted)] mb-0.5">{label}</p>
      <p className={`text-sm tabular font-medium ${colorClass}`}>{value}</p>
    </div>
  );
}

function formatDollars(n: number): string {
  const sign = n >= 0 ? "" : "-";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

const NY_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const NY_MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  year: "numeric",
});

/** Compact month label for contract spans, e.g. "Jan 2026". */
function formatMonthSpan(iso: string): string {
  return NY_MONTH_FORMATTER.format(new Date(iso));
}

function formatShortDate(iso: string): string {
  const parts = NY_DATE_FORMATTER.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}/${get("day")}/${get("year")} ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
}

/** Month/day only, no time — for coverage notices where day granularity is sufficient. */
function formatDateOnly(iso: string): string {
  const parts = NY_DATE_FORMATTER.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}/${get("day")}/${get("year")}`;
}
