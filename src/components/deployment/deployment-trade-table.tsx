"use client";

import { Fragment, useEffect, useState } from "react";
import { TradeChart } from "@/components/chart/trade-chart";
import { Chevron } from "@/components/chevron";
import { formatUsd, pnlToneClass } from "@/components/board/board-view";
import { describeSectionCount, splitAccountName } from "@/components/deployment/deployment-detail-model";
import { exportDeploymentTradesAsJson, type TradeBarsEntry } from "@/lib/trading/deployment-trades-export";
import type { MainSession } from "@/lib/trading/strategy-types";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { Deployment } from "@/lib/trading/domain";
import { CHIP_CLASS, CHIP_TONE, classifyExitReason } from "@/components/exit-reason-chips";
import type { BarData } from "@/lib/brokers/types";

/**
 * The drill-in's trade table — one row per trade, expandable to its chart.
 *
 * Rewritten out of `deployment-trades.tsx`, which mounted inside a board row
 * and carried the backtest-comparison surfaces with it. Those are gone
 * (punchlist: *backtest comparison in the deployment view has no actionable
 * value until trigger-price tracking gives a meaningful benchmark*), so the
 * BT column, the LIVE/BACKTEST/DELTA strip and the analytics tab are not
 * here. What is here is the history: what was entered, at what price against
 * what the strategy wanted, how it exited, and what it made.
 *
 * **Money renders through `board-view.ts`'s `formatUsd` / `pnlToneClass`.**
 * This file used to hold a third convention (`$-40.00` on negatives) and its
 * own tone map where zero was `--muted`. See the punchlist entry the
 * drill-in closes.
 *
 * **Numbers are monospace with tabular figures.** The table this replaces was
 * sans-12px by coincidence — eleven fixed columns inside a nested card had no
 * room for mono glyphs. On a full-width route with the BT column gone it
 * does, so the Hard rule applies rather than the carve-out.
 */

// ── Formatters ──────────────────────────────────────────────────────────

// MM/DD/YYYY, HH:MM:SS — full precision so trade rows can be cross-
// referenced against the broker's timestamps to the second.
const TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return TIME_FORMATTER.format(new Date(iso));
}

function fmtPrice(n: number | null): string {
  return n == null ? "—" : n.toFixed(2);
}

function fmtTicks(n: number | null): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}`;
}

/** For slippage, positive = worse (it cost us) and negative = price
 *  improvement, so the sign is inverted before it reaches the shared tone map
 *  and red still means bad. */
function slippageToneClass(n: number | null): string {
  return n == null ? "text-[var(--muted)]" : pnlToneClass(-n);
}

/**
 * Render a desired bracket as `price (ticks)`, or as `price` alone when the
 * Account column is in scope.
 *
 * **The parenthetical is dropped because the track is not there, not because
 * it stopped mattering.** Inside the shell's 1152px, `table-fixed`, the fixed
 * tracks leave this cell ~176px with an Account column and ~304px without;
 * `21345.25 (80) / 21345.25 (80)` is ~230px. The cell is `whitespace-nowrap`,
 * so the overflow was a spill across the Slippage column rather than a
 * truncation. The full `price (ticks)` pair stays one hover away in the
 * cell's `title` — see `desiredBracketTitle`.
 */
function fmtDesiredBracket(price: number | null, ticks: number | null, withTicks: boolean): string {
  if (price == null || ticks == null) return "—";
  if (!withTicks) return price.toFixed(2);
  return `${price.toFixed(2)} (${Math.abs(ticks).toFixed(0)})`;
}

/** The un-abbreviated TP / SL pair, for the compact cell's tooltip. `null`
 *  when the compact form is already the whole of it. */
function desiredBracketTitle(t: StrategyTrade, compact: boolean): string | undefined {
  if (!compact) return undefined;
  if (t.desiredTpPrice == null && t.desiredSlPrice == null) return undefined;
  return `TP ${fmtDesiredBracket(t.desiredTpPrice, t.desiredTpTicks, true)} / SL ${fmtDesiredBracket(t.desiredSlPrice, t.desiredSlTicks, true)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function filenameStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

// Strip filesystem-illegal chars on Windows (slashes, colons, control,
// reserved punctuation). Hyphens, underscores, and digits pass through.
function sanitizeFilenamePart(s: string): string {
  return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
}

/** Pull the per-trade bar snapshots for an export. Returns an empty map on
 *  fetch/parse failure so the export still proceeds with `bars: null` on
 *  every row instead of failing the whole action. */
async function fetchTradesBars(
  tradeIds: number[],
  token: string | null,
): Promise<Map<number, TradeBarsEntry>> {
  const out = new Map<number, TradeBarsEntry>();
  if (tradeIds.length === 0 || !token) return out;
  try {
    const res = await fetch("/api/trades/bars-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tradeIds }),
    });
    if (!res.ok) {
      console.warn(`[export] bars-batch failed (${res.status}); exporting without bars`);
      return out;
    }
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") return out;
    const rows = (data as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) return out;
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const row = r as { tradeId?: unknown; bars?: unknown; timeframe?: unknown; barsMatureAt?: unknown };
      if (typeof row.tradeId !== "number" || !Array.isArray(row.bars) || typeof row.timeframe !== "string") {
        continue;
      }
      out.set(row.tradeId, {
        bars: row.bars as BarData[],
        timeframe: row.timeframe,
        barsMatureAt: typeof row.barsMatureAt === "string" ? row.barsMatureAt : null,
      });
    }
    return out;
  } catch (err) {
    console.warn("[export] bars-batch threw; exporting without bars", err);
    return out;
  }
}

// ── The exit-reason chip ────────────────────────────────────────────────

/**
 * Compact short-code chip in the Exit cell, keyed on the row's exit-reason
 * **code**. Hover surfaces the rendered label.
 *
 * The map, the tone table and the classifier moved to
 * `exit-reason-chips.ts` when the chart's `exitLabel` needed the same three
 * letters — see that module's header. This file still owns no exit-reason
 * strings; it now owns none of the codes either.
 */
function ExitReasonChip({ reason, reasonCode }: { reason: string | null; reasonCode: string | null }) {
  if (!reason) return null;
  const { code, group } = classifyExitReason(reasonCode, reason);
  return (
    <span title={reason} className={`ml-1.5 ${CHIP_CLASS} ${CHIP_TONE[group]}`}>
      {code}
    </span>
  );
}

function SideBadge({ side }: { side: number }) {
  const isBuy = side === 0;
  return (
    <span
      className={`inline-flex items-center justify-center rounded-sm px-2 py-0.5 text-[10px] font-semibold tracking-wide ${
        isBuy
          ? "bg-[var(--success)]/10 text-[var(--success)]"
          : "bg-[var(--danger)]/10 text-[var(--danger)]"
      }`}
    >
      {isBuy ? "BUY" : "SELL"}
    </span>
  );
}

// ── The table ───────────────────────────────────────────────────────────

const TH = "px-3 py-2 font-medium";

/**
 * **The track widths are load-bearing, and the multi-account view is the one
 * to check.** `table-fixed` inside the shell's `max-w-[1200px] … px-6` leaves
 * 1152px; every column but TP / SL is fixed, so that cell gets the remainder
 * and a cell wider than its remainder spills sideways rather than wrapping —
 * it carries `whitespace-nowrap`. At `text-xs` mono (~7.2px per glyph) the
 * budget is:
 *
 * `32 + 176 + 128? + 64 + 48 + 96 + 96 + 80 + 144 + 112` — 976 with the
 * Account column and 848 without, leaving TP / SL **176px** in the
 * multi-account view and 304px in the single-account one. The compact
 * `21345.25 / 21345.25` is ~158px; the full `21345.25 (80) / 21345.25 (80)`
 * is ~230px, which is why the parenthetical drops when `showAccount` is on
 * and moves to the cell's tooltip. Trigger is `w-24` rather than `w-20`
 * because `21345.25` plus `px-3` is ~82px and does not fit an 80px box.
 *
 * Adding a column here means redoing this arithmetic for the multi-account
 * case, which is the *default* for a group and the case this route exists
 * for. It is not enough for the single-account view to fit.
 */
function TradeTableHeader({ showAccount }: { showAccount: boolean }) {
  return (
    <thead className="sticky top-0 z-10 bg-[var(--card)]">
      <tr className="border-b border-[var(--card-border)] text-left text-[10px] uppercase tracking-wider text-[var(--muted)]">
        <th className="w-8 px-2 py-2 font-medium"></th>
        <th className={`${TH} w-[11rem]`}>Time Entered</th>
        {showAccount && <th className={`${TH} w-[8rem]`}>Account</th>}
        <th className={`${TH} w-16`}>Side</th>
        <th className={`${TH} w-12`}>Size</th>
        <th
          className={`${TH} w-24`}
          title="Trigger price — bar close at signal time, which is what the strategy decided to enter at."
        >
          Trigger
        </th>
        <th className={`${TH} w-24`} title="Fill price — what the broker actually filled the entry at.">
          Fill
        </th>
        <th
          className={TH}
          title={
            showAccount
              ? "Where the TP and SL are resting, on every broker — both anchor the bracket to the trigger, not to the fill. Hover a row for the tick offsets. A breakeven move is not shown here."
              : "Where the TP and SL are resting, on every broker — both anchor the bracket to the trigger, not to the fill, with the tick offset from it. A breakeven move is not shown here."
          }
        >
          TP / SL
        </th>
        <th
          className={`${TH} w-20`}
          title="Entry slippage in ticks. + = worse than trigger, − = price improvement."
        >
          Slippage
        </th>
        <th className={`${TH} w-36`}>Exit</th>
        <th className={`${TH} w-28 text-right`}>PnL</th>
      </tr>
    </thead>
  );
}

interface TradeRowProps {
  trade: StrategyTrade;
  zebra: string;
  expanded: boolean;
  showAccount: boolean;
  accountName: string;
  onToggle: () => void;
  liveUnrealized: number | null;
  token: string | null;
  onDeleted: (tradeId: number) => void;
}

const NUM = "px-3 py-2 font-mono tabular";

function TradeRow({
  trade: t,
  zebra,
  expanded,
  showAccount,
  accountName,
  onToggle,
  liveUnrealized,
  token,
  onDeleted,
}: TradeRowProps) {
  const open = isOpen(t);
  const renderedPnl = open ? liveUnrealized : t.pnlDollars;
  const columns = showAccount ? 11 : 10;

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function openDeleteConfirm(e: React.MouseEvent) {
    e.stopPropagation();
    setConfirmDelete(true);
    setDeleteError(null);
  }

  function cancelDelete(e?: React.MouseEvent) {
    e?.stopPropagation();
    setConfirmDelete(false);
    setDeleteError(null);
  }

  async function confirmDeleteAction(e: React.MouseEvent) {
    e.stopPropagation();
    if (!token || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/trades/${t.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setDeleteError(data.error ?? `Delete failed (${res.status})`);
        return;
      }
      setConfirmDelete(false);
      onDeleted(t.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Fragment>
      <tr
        onClick={onToggle}
        className={`group cursor-pointer border-b border-[var(--card-border)] transition-colors last:border-0 hover:bg-[var(--hover)] ${zebra}`}
        aria-expanded={expanded}
      >
        <td className="px-2 py-2 align-top text-[var(--muted)]">
          <Chevron expanded={expanded} />
        </td>
        <td className={`${NUM} text-[var(--muted)]`}>{fmtTime(t.entryFilledAt ?? t.entrySubmittedAt)}</td>
        {showAccount && (
          <td className={`${NUM} text-[var(--foreground)]`} title={accountName}>
            {/* Middle truncation: the head gives up characters, the account
                suffix never does. See `splitAccountName`. */}
            <span className="flex">
              <span className="truncate">{splitAccountName(accountName).head}</span>
              <span className="shrink-0">{splitAccountName(accountName).tail}</span>
            </span>
          </td>
        )}
        <td className="px-3 py-2">
          <SideBadge side={t.side} />
        </td>
        <td className={NUM}>{t.size}</td>
        <td className={NUM}>{fmtPrice(t.desiredEntryPrice)}</td>
        <td className={NUM}>{fmtPrice(t.entryPrice)}</td>
        {/* `truncate` is the structural half of the width budget in
            `TradeTableHeader`: without it a future column narrows this track
            and the numbers spill across Slippage. It is `truncate` rather than
            bare `overflow-hidden` because a clipped price is a *different*
            price that still looks like a price — `21345.25 / 21345.2` reads as
            a valid SL. The ellipsis is what says the number is cut. */}
        <td
          className={`${NUM} truncate`}
          title={desiredBracketTitle(t, showAccount)}
        >
          {fmtDesiredBracket(t.desiredTpPrice, t.desiredTpTicks, !showAccount)}
          <span className="mx-1.5 text-[var(--muted)]">/</span>
          {fmtDesiredBracket(t.desiredSlPrice, t.desiredSlTicks, !showAccount)}
        </td>
        <td
          className={`${NUM} ${slippageToneClass(t.entrySlippageTicks)}`}
          title={
            t.entrySlippageDollars != null ? formatUsd(-t.entrySlippageDollars) : undefined
          }
        >
          {fmtTicks(t.entrySlippageTicks)}
        </td>
        <td
          className={NUM}
          title={t.exitApproximated ? "Approximated — awaiting broker indexing" : undefined}
        >
          {t.exitApproximated && t.exitPrice != null ? "~" : ""}
          {fmtPrice(t.exitPrice)}
          <ExitReasonChip reason={t.exitReason} reasonCode={t.exitReasonCode} />
        </td>
        <td
          className={`${NUM} text-right ${renderedPnl == null ? "text-[var(--muted)]" : pnlToneClass(renderedPnl)}`}
          title={!open && t.exitApproximated ? "Approximated — awaiting broker indexing" : undefined}
        >
          {!open && t.exitApproximated && renderedPnl != null ? "~" : ""}
          {renderedPnl != null ? formatUsd(renderedPnl) : "—"}
          {!open && (
            <span className="relative ml-2 inline-flex items-center" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                title={`Delete trade #${t.id}`}
                onClick={openDeleteConfirm}
                className={`inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors ${
                  confirmDelete
                    ? "invisible"
                    : "text-[var(--muted)] hover:bg-[var(--danger)]/15 hover:text-[var(--danger)]"
                }`}
                aria-label={`Delete trade ${t.id}`}
              >
                <svg width="14" height="14" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
                  <path
                    d="M1.5 2.5h7M4 2.5V1.5h2V2.5M3 2.5v6h4v-6"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {confirmDelete && (
                <span className="absolute right-0 top-1/2 z-10 inline-flex -translate-y-1/2 items-center gap-1">
                  <button
                    type="button"
                    onClick={(e) => void confirmDeleteAction(e)}
                    disabled={deleting}
                    className="rounded-md border border-[var(--danger)]/60 bg-[var(--danger)]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/25 disabled:opacity-40"
                  >
                    {deleting ? "…" : "Del"}
                  </button>
                  <button
                    type="button"
                    onClick={cancelDelete}
                    disabled={deleting}
                    className="rounded-md border border-[var(--card-border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)] transition-colors hover:text-[var(--foreground)] disabled:opacity-40"
                  >
                    No
                  </button>
                </span>
              )}
            </span>
          )}
        </td>
      </tr>
      {deleteError && (
        <tr className={`${zebra} border-b border-[var(--card-border)]`}>
          <td colSpan={columns} className="px-4 py-1.5">
            <span className="font-mono text-[11px] text-[var(--danger)]">{deleteError}</span>
          </td>
        </tr>
      )}
      {expanded && (
        <tr className="border-b border-[var(--card-border)] bg-[var(--bg-row-deep)]">
          <td colSpan={columns} className="p-0">
            <TradeChart tradeId={t.id} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── The section ─────────────────────────────────────────────────────────

export function isOpen(t: StrategyTrade): boolean {
  return t.status === "open" || t.status === "pending_entry" || t.status === "pending_exit";
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const PAGE_SIZE_STORAGE_KEY = "trades-page-size";
const DEFAULT_PAGE_SIZE = 25;

export const EXPORT_NEEDS_ONE_ACCOUNT =
  "Pick an account to export — the file carries one account's configuration alongside its trades.";

/** **The export is the loaded window, not the history.** `listTrades` caps at
 *  200 and the button hands `historic` straight to the serializer, so a
 *  tooltip promising "this account's closed trades" oversells it — with
 *  `describeTruncation` rendering the real number a few pixels below. */
export const EXPORT_COVERS_LOADED =
  "Download this account's loaded closed trades as JSON, with the per-trade bar snapshots. It covers the loaded window — the most recent 200 — not the deployment's full history.";

export interface DeploymentTradeTableProps {
  /** Already scoped to the selected accounts by the page. */
  trades: readonly StrategyTrade[];
  /** Account name per `deployments` row id, for the Account column. */
  accountNameFor: (deploymentId: string) => string;
  /** Rendered only when more than one leg is in scope — a single-account
   *  view would print the same string on every row. */
  showAccount: boolean;
  /** Live unrealized for an open row, or null when nothing can price it. */
  liveUnrealizedFor: (t: StrategyTrade) => number | null;
  token: string | null;
  onDeleted: () => void;
  /** The one leg an export would describe, or null when the selection spans
   *  several — the file carries one deployment's configuration alongside its
   *  trades, so it cannot speak for three. `session` is the playbook's own
   *  window, carried down from the card rather than looked up here: the
   *  strategy registry is a build-time `require.context` and importing it into
   *  a component takes a bundler mechanism with it. */
  exportLeg: { deployment: Deployment; accountName: string; session: MainSession | null } | null;
  /** Sits under the table when the list is capped below the summary. */
  truncationNote: string | null;
  /**
   * The server's own uncapped counts for the same scope, or `null` until the
   * summary lands. The section bars print these rather than folding the
   * loaded rows — see `describeSectionCount`, which owns why.
   */
  serverCounts: { open: number | null; closed: number | null };
  /**
   * Which selection these trades are. Changing it resets the page, because
   * page 5 of All accounts is not page 5 of one leg — `safePage` clamps the
   * render so it looks fine while answering about a different set of rows.
   */
  scopeKey: string;
}

export function DeploymentTradeTable({
  trades,
  accountNameFor,
  showAccount,
  liveUnrealizedFor,
  token,
  onDeleted,
  exportLeg,
  truncationNote,
  serverCounts,
  scopeKey,
}: DeploymentTradeTableProps) {
  // One chart open at a time — opening another replaces it, so a long list
  // never accumulates heavy chart instances or stacked vertical scroll.
  const [expandedTradeId, setExpandedTradeId] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);

  // Reset the page when the scope changes, adjusting during render rather
  // than in an effect so there is no frame showing page 5 of the new set.
  // A `key` would do it too, but it would also remount past the
  // `localStorage` read below and flash the default page size.
  const [renderedScope, setRenderedScope] = useState(scopeKey);
  if (renderedScope !== scopeKey) {
    setRenderedScope(scopeKey);
    setPage(0);
    // The open chart is an answer to the old question too. A trade belongs to
    // one leg, so narrowing scope either keeps it or drops it and collapses
    // the chart on its own — but that is the list's behaviour covering for
    // this, not this being right, and widening scope leaves it open at a row
    // that has moved pages.
    setExpandedTradeId(null);
  }

  useEffect(() => {
    const stored = localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
    const n = stored ? Number(stored) : NaN;
    if (PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number])) setPageSize(n);
  }, []);

  const liveTrades = trades.filter(isOpen);
  const historic = trades.filter((t) => !isOpen(t));

  const totalPages = Math.max(1, Math.ceil(historic.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, historic.length);
  const visible = historic.slice(pageStart, pageEnd);

  // Page-scoped aggregates: what the operator is looking at right now, and
  // labelled as such. The all-time figures are the server's, in the stats
  // strip above — one reducer per figure, never two for the same number.
  let pagePnl = 0;
  let pagePnlCount = 0;
  let slipTicks = 0;
  let slipDollars = 0;
  let slipCount = 0;
  for (const t of visible) {
    if (t.pnlDollars != null) {
      pagePnl += t.pnlDollars;
      pagePnlCount += 1;
    }
    if (t.entrySlippageTicks != null) {
      slipTicks += t.entrySlippageTicks;
      slipCount += 1;
    }
    if (t.entrySlippageDollars != null) slipDollars += t.entrySlippageDollars;
  }
  const avgSlipTicks = slipCount > 0 ? slipTicks / slipCount : null;

  function onPageSizeChange(n: number) {
    setPageSize(n);
    setPage(0);
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(n));
  }

  function handleDeleted(tradeId: number) {
    if (expandedTradeId === tradeId) setExpandedTradeId(null);
    onDeleted();
  }

  async function onExport() {
    if (!exportLeg || historic.length === 0 || exporting) return;
    setExporting(true);
    try {
      const own = historic.filter((t) => t.deploymentId === exportLeg.deployment.id);
      const tradesBars = await fetchTradesBars(own.map((t) => t.id), token);
      const json = exportDeploymentTradesAsJson({
        deployment: exportLeg.deployment,
        trades: own,
        accountName: exportLeg.accountName,
        session: exportLeg.session,
        tradesBars,
      });
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `deployment-${exportLeg.deployment.strategyKey}-${exportLeg.deployment.ticker}-${sanitizeFilenamePart(exportLeg.accountName)}-${filenameStamp(new Date())}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  // **No `key` in here.** A `key` inside a spread object is not read as a
  // key — React takes it off the props and warns, and the list falls back to
  // index identity, so an open row settling into the closed table hands its
  // expanded/confirm state to whatever row inherits its index. It is passed
  // explicitly at both call sites instead.
  const rowProps = (t: StrategyTrade, i: number) => ({
    trade: t,
    zebra: i % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]",
    expanded: expandedTradeId === t.id,
    showAccount,
    accountName: accountNameFor(t.deploymentId),
    onToggle: () => setExpandedTradeId((prev) => (prev === t.id ? null : t.id)),
    token,
    onDeleted: handleDeleted,
  });

  return (
    <div className="border border-[var(--card-border)] bg-[var(--card)]">
      {/* The server's count, not a fold of the loaded rows — the list is
          capped and the strip above is not, so the two disagreed the moment
          an open row fell outside the window. */}
      <SectionBar>
        {serverCounts.open === 0 && liveTrades.length === 0
          ? "No Open Position"
          : `Open Position ${describeSectionCount({ total: serverCounts.open, shown: liveTrades.length })}`}
      </SectionBar>
      {liveTrades.length > 0 && (
        <table className="w-full table-fixed text-xs">
          <TradeTableHeader showAccount={showAccount} />
          <tbody>
            {liveTrades.map((t, i) => (
              <TradeRow key={t.id} {...rowProps(t, i)} liveUnrealized={liveUnrealizedFor(t)} />
            ))}
          </tbody>
        </table>
      )}

      <SectionBar>
        {`Closed Positions ${describeSectionCount({ total: serverCounts.closed, shown: historic.length })}`}
      </SectionBar>
      {historic.length === 0 ? (
        <p className="px-4 py-6 text-sm text-[var(--muted)]">No closed trades yet.</p>
      ) : (
        <>
          <table className="w-full table-fixed text-xs">
            <TradeTableHeader showAccount={showAccount} />
            <tbody>
              {visible.map((t, i) => (
                <TradeRow key={t.id} {...rowProps(t, i)} liveUnrealized={null} />
              ))}
            </tbody>
          </table>

          <div className="flex items-center justify-between gap-3 border-t border-[var(--card-border)] bg-[var(--bg)] px-4 py-2 text-xs text-[var(--muted)]">
            <div className="flex flex-wrap items-center gap-4">
              <span className="font-mono tabular">
                Showing {pageStart + 1}–{pageEnd} of {historic.length}
              </span>
              {pagePnlCount > 0 && (
                <span className="font-mono tabular">
                  <span className="text-[10px] uppercase tracking-wider">page pnl</span>{" "}
                  <span className={pnlToneClass(pagePnl)}>{formatUsd(pagePnl)}</span>
                </span>
              )}
              {slipCount > 0 && (
                <>
                  <span
                    className="font-mono tabular"
                    title="Mean entry slippage in ticks across the visible trades. + = worse than trigger; − = price improvement."
                  >
                    <span className="text-[10px] uppercase tracking-wider">avg slip</span>{" "}
                    <span className={slippageToneClass(avgSlipTicks)}>{fmtTicks(avgSlipTicks)}t</span>
                  </span>
                  <span
                    className="font-mono tabular"
                    title="Sum of entry slippage in dollars across the visible trades. Negative = price improvement; positive = cost."
                  >
                    <span className="text-[10px] uppercase tracking-wider">slip cost</span>{" "}
                    <span className={pnlToneClass(-slipDollars)}>{formatUsd(-slipDollars)}</span>
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">
                Per page:
                <select
                  value={pageSize}
                  onChange={(e) => onPageSizeChange(Number(e.target.value))}
                  className="tabular rounded-md border border-[var(--card-border)] bg-[var(--card)] px-2 py-0.5 font-mono"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="rounded-md border border-[var(--card-border)] px-2 py-0.5 hover:border-[var(--accent)] disabled:opacity-30"
                >
                  ‹ Prev
                </button>
                <span className="tabular px-1 font-mono">
                  {safePage + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                  className="rounded-md border border-[var(--card-border)] px-2 py-0.5 hover:border-[var(--accent)] disabled:opacity-30"
                >
                  Next ›
                </button>
              </div>
              {/* Primary action far right, per the design language. */}
              <button
                type="button"
                onClick={() => void onExport()}
                disabled={exportLeg == null || exporting}
                className="rounded-md border border-[var(--card-border)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest hover:border-[var(--accent)] disabled:opacity-30"
                title={exportLeg == null ? EXPORT_NEEDS_ONE_ACCOUNT : EXPORT_COVERS_LOADED}
              >
                {exporting ? "Exporting…" : "Export (JSON)"}
              </button>
            </div>
          </div>

          {truncationNote && (
            <p className="border-t border-[var(--card-border)] bg-[var(--bg)] px-4 py-1.5 text-[11px] text-[var(--muted-secondary)]">
              {truncationNote}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SectionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--card-border)] bg-[var(--bg)] px-4 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]">
        {children}
      </span>
    </div>
  );
}
