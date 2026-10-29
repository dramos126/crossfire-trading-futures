"use client";

import { useMemo, useState } from "react";
import { BacktestProgressBar, BacktestSummary } from "@/components/backtest/backtest-panel";
import { displayLabels, type OutcomeFilter } from "@/components/backtest/backtest-run-model";
import { RunReader, useChartPrefs, useSavedRuns } from "@/components/backtest/backtest-runs-panel";
import { ParamForm } from "@/components/param-form";
import { PlaybookSection } from "@/components/playbook/playbook-section";
import {
  browserRunSummary,
  DEFAULT_SIZING_DRAFT,
  describeChangedCount,
  describeDropped,
  describeLoaded,
  describeOtherInstrument,
  fixedSizingPlaybookNote,
  LOAD_PLACEHOLDER,
  loadFromRun,
  NO_SAVED_RUNS_TO_LOAD,
  RESET_LABEL,
  resolveSizing,
  settingsRefusal,
  sizingResearchNote,
  TRY_DATES_NOTE,
  TRY_NOT_SAVED,
  TRY_SETTINGS_HELP,
  tryInstrument,
  type LoadedRun,
  type SizingDraft,
  type TryInstrument,
} from "@/components/playbook/playbook-try-model";
import {
  DEFAULT_INCLUDE_FEES,
  DEFAULT_LOOKBACK_DAYS,
  toDateInputValue,
  useBacktestRunner,
} from "@/lib/hooks/use-backtest-runner";
import type { BacktestSizing } from "@/lib/trading/backtest";
import {
  buildRunExport,
  changedParamKeys,
  runExportFilename,
} from "@/lib/trading/backtest-run-export";
import { feePerSideFor } from "@/lib/trading/orders/fees";
import {
  defaultParamValues,
  type ParamValues,
  type StrategyModule,
} from "@/lib/trading/strategy-types";

/**
 * *Try settings* on `/playbooks/[key]`: run this playbook in the browser on
 * edited settings and read the trades through the same reader as a saved run.
 *
 * **Nothing here writes.** The playbook's constants stay in code and the run
 * is not saved; *Export settings* downloads the backtest command that would
 * run and save it. Every decision — what a load fills, which sizing is
 * refused, what the export command says — is in `playbook-try-model.ts` and
 * `backtest-run-export.ts`; this file wires them to the runner.
 */
export function PlaybookTrySettings({
  playbookKey,
  module,
}: {
  playbookKey: string;
  module: StrategyModule;
}) {
  const instrument = tryInstrument(module.config);
  if (instrument.kind === "inert") {
    return (
      <PlaybookSection title="Try settings" help={TRY_SETTINGS_HELP} collapsible>
        <p className="text-xs text-[var(--muted)]">{instrument.reason}</p>
      </PlaybookSection>
    );
  }
  return <TrySettingsForm playbookKey={playbookKey} module={module} instrument={instrument} />;
}

const INPUT_CLASS =
  "px-3 py-2 rounded-md bg-[var(--background)] border border-[var(--card-border)] text-sm focus:outline-none focus:border-[var(--accent)]";
const LABEL_CLASS = "block text-xs text-[var(--muted)] mb-1";
const SECONDARY_BUTTON =
  "rounded-md border border-[var(--card-border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--accent)] transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/** What a pressed Run ran on — the result is described by these, not by the
 *  form, which the operator may have edited since. */
interface RanWith {
  sizing: BacktestSizing;
  from: string;
  to: string;
}

function TrySettingsForm({
  playbookKey,
  module,
  instrument,
}: {
  playbookKey: string;
  module: StrategyModule;
  instrument: Extract<TryInstrument, { kind: "ready" }>;
}) {
  const schema = module.params;
  const [params, setParams] = useState<ParamValues>(() => defaultParamValues(schema));
  const [sizingDraft, setSizingDraft] = useState<SizingDraft>(DEFAULT_SIZING_DRAFT);
  const [loaded, setLoaded] = useState<LoadedRun | null>(null);
  const [ranWith, setRanWith] = useState<RanWith | null>(null);
  const [filter, setFilter] = useState<OutcomeFilter>("all");

  const { runs: savedRuns, settled: runsSettled } = useSavedRuns(playbookKey);
  const chartPrefs = useChartPrefs();

  // The runner takes sizing as an argument and holds the fees box, so the
  // shape is resolved before it and the fees refusal after; Run and Export
  // are disabled on the second, so the first never reaches a request alone.
  const sizingShape = resolveSizing(sizingDraft, true);
  const runner = useBacktestRunner({
    strategyKey: playbookKey,
    ticker: instrument.ticker,
    params,
    sizing: sizingShape.ok ? sizingShape.sizing : undefined,
  });
  const resolved = resolveSizing(sizingDraft, runner.includeFees);
  const setIncludeFees = runner.setIncludeFees;

  const timeframe = String(params.timeframe ?? module.config.timeframe);
  const changedCount = changedParamKeys(schema, params).length;
  const researchNote = sizingResearchNote(sizingDraft);
  const playbookLimitsNote = fixedSizingPlaybookNote(sizingDraft, params);

  const resetToDefaults = () => {
    setParams(defaultParamValues(schema));
    setSizingDraft(DEFAULT_SIZING_DRAFT);
    setIncludeFees(DEFAULT_INCLUDE_FEES);
    runner.applyPreset(DEFAULT_LOOKBACK_DAYS);
    setLoaded(null);
  };

  const loadRun = (runPath: string) => {
    const run = savedRuns.find((r) => r.runPath === runPath);
    if (run == null) {
      resetToDefaults();
      return;
    }
    const next = loadFromRun(schema, run, instrument.spec);
    setParams(next.params);
    setSizingDraft(next.sizing ?? DEFAULT_SIZING_DRAFT);
    setIncludeFees(next.includeFees ?? DEFAULT_INCLUDE_FEES);
    if (next.from != null && next.to != null) {
      runner.setStartDate(next.from);
      runner.setEndDate(next.to);
    } else {
      runner.applyPreset(DEFAULT_LOOKBACK_DAYS);
    }
    setLoaded(next);
  };

  const paramsRefused = settingsRefusal(playbookKey, module, params);
  const blockedReason = resolved.ok ? paramsRefused : resolved.reason;

  const press = () => {
    if (!resolved.ok || blockedReason != null) return;
    setRanWith({ sizing: resolved.sizing, from: runner.startDate, to: runner.endDate });
    void runner.run();
  };

  const exportSettings = () => {
    if (!resolved.ok || blockedReason != null) return;
    const now = new Date();
    const file = buildRunExport({
      playbookKey,
      playbookVersion: module.version ?? null,
      schema,
      ticker: instrument.spec,
      from: runner.startDate,
      to: runner.endDate,
      params,
      timeframe,
      includeFees: runner.includeFees,
      feePerSideUsd: feePerSideFor(instrument.ticker),
      sizing: resolved.sizing,
      loadedFrom: loaded?.source ?? null,
      now,
    });
    downloadJson(file, runExportFilename(playbookKey, now));
  };

  const summary = useMemo(
    () =>
      runner.result != null && ranWith != null
        ? browserRunSummary(
            runner.result,
            {
              key: playbookKey,
              version: module.version ?? null,
              calibratedFor: module.config.calibratedFor ?? null,
            },
            { from: ranWith.from, to: ranWith.to },
            ranWith.sizing,
          )
        : null,
    [runner.result, ranWith, playbookKey, module],
  );

  const dropped = loaded ? describeDropped(loaded) : null;
  const otherInstrument = loaded ? describeOtherInstrument(loaded) : null;

  return (
    <PlaybookSection
      title="Try settings"
      help={TRY_SETTINGS_HELP}
      collapsible
      right={
        <span className="font-mono tabular">
          {instrument.spec} · {timeframe} · {describeChangedCount(changedCount)}
        </span>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="try-load-run" className={LABEL_CLASS}>
              Load from saved run
            </label>
            {runsSettled && savedRuns.length === 0 ? (
              <p className="py-2 text-xs text-[var(--muted)]">{NO_SAVED_RUNS_TO_LOAD}</p>
            ) : (
              <SavedRunSelect
                runs={savedRuns}
                value={loaded?.source.runPath ?? ""}
                onChange={loadRun}
              />
            )}
          </div>
          <button type="button" onClick={resetToDefaults} className={`${SECONDARY_BUTTON} mb-1`}>
            {RESET_LABEL}
          </button>
        </div>

        {loaded && (
          <div className="space-y-1 text-[11px]">
            <p className="text-[var(--muted)]">{describeLoaded(loaded)}</p>
            {otherInstrument && <p className="text-[var(--warning)]">{otherInstrument}</p>}
            {dropped &&<p className="text-[var(--warning)]">{dropped}</p>}
          </div>
        )}

        <ParamForm
          schema={schema}
          values={params}
          onChange={setParams}
          hiddenKeys={module.config.hiddenCommonParams as string[] | undefined}
          explore
        />

        <div role="group" aria-label="Dates" className="border-t border-[var(--card-border)] pt-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="try-start-date" className={LABEL_CLASS}>
                Start Date
              </label>
              <input
                id="try-start-date"
                type="date"
                aria-label="Start date"
                className={`${INPUT_CLASS} w-full font-mono tabular-nums`}
                value={runner.startDate}
                max={runner.endDate}
                onChange={(e) => runner.setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="try-end-date" className={LABEL_CLASS}>
                End Date
              </label>
              <input
                id="try-end-date"
                type="date"
                aria-label="End date"
                className={`${INPUT_CLASS} w-full font-mono tabular-nums`}
                value={runner.endDate}
                min={runner.startDate}
                max={toDateInputValue(new Date())}
                onChange={(e) => runner.setEndDate(e.target.value)}
              />
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--muted)]">{TRY_DATES_NOTE}</p>
        </div>

        <SizingControls
          draft={sizingDraft}
          onChange={setSizingDraft}
          includeFees={runner.includeFees}
          onIncludeFees={setIncludeFees}
          researchNote={researchNote}
          playbookLimitsNote={playbookLimitsNote}
        />

        {blockedReason && (
          <p className="border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]">
            {blockedReason}
          </p>
        )}

        <div className="flex items-center gap-2 border-t border-[var(--card-border)] pt-3">
          <span className="text-[11px] text-[var(--muted)]">{TRY_NOT_SAVED}</span>
          <button
            type="button"
            onClick={exportSettings}
            disabled={blockedReason != null}
            title={blockedReason ?? undefined}
            className={`${SECONDARY_BUTTON} ml-auto`}
          >
            Export settings
          </button>
          {/* Primary execution action, anchored far right. */}
          <button
            type="button"
            onClick={press}
            disabled={blockedReason != null || !runner.canRun}
            title={blockedReason ?? undefined}
            className="btn-emerald rounded-md px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {runner.running ? "Running…" : "Run"}
          </button>
        </div>

        {runner.error && (
          <div className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
            {runner.error}
          </div>
        )}

        {runner.running && <BacktestProgressBar progress={runner.progress} />}

        {runner.result != null && summary != null && (
          <div className="space-y-4 border-t border-[var(--card-border)] pt-3">
            <BacktestSummary response={runner.result} />
            <RunReader
              summary={summary}
              trades={runner.result.tradeRecords}
              arrowKeys="within"
              filter={filter}
              onFilterChange={setFilter}
              chartPrefs={chartPrefs}
            />
          </div>
        )}
      </div>
    </PlaybookSection>
  );
}

function SavedRunSelect({
  runs,
  value,
  onChange,
}: {
  runs: ReturnType<typeof useSavedRuns>["runs"];
  value: string;
  onChange: (runPath: string) => void;
}) {
  const labels = useMemo(() => displayLabels(runs), [runs]);
  return (
    <select
      id="try-load-run"
      className={`${INPUT_CLASS} min-w-[20rem] font-mono`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{LOAD_PLACEHOLDER}</option>
      {runs.map((r) => {
        const d = labels.get(r.runPath) ?? { label: r.label, parent: null };
        return (
          <option key={r.runPath} value={r.runPath}>
            {`${d.parent != null ? `${d.parent}/` : ""}${d.label} · ${r.ticker} ${r.timeframe} · ${r.from} → ${r.to}`}
          </option>
        );
      })}
    </select>
  );
}

function SizingControls({
  draft,
  onChange,
  includeFees,
  onIncludeFees,
  researchNote,
  playbookLimitsNote,
}: {
  draft: SizingDraft;
  onChange: (next: SizingDraft) => void;
  includeFees: boolean;
  onIncludeFees: (on: boolean) => void;
  researchNote: string | null;
  playbookLimitsNote: string | null;
}) {
  const numberOrNull = (raw: string): number | null => (raw === "" ? null : Number(raw));
  return (
    <div role="group" aria-label="Sizing" className="space-y-2">
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="try-sizing-mode"
            checked={draft.mode === "fixed"}
            onChange={() => onChange({ ...draft, mode: "fixed" })}
            className="w-3.5 h-3.5 accent-[var(--accent)]"
          />
          <span>Fixed contracts</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="try-sizing-mode"
            checked={draft.mode === "risk"}
            onChange={() => onChange({ ...draft, mode: "risk" })}
            className="w-3.5 h-3.5 accent-[var(--accent)]"
          />
          <span>Risk per trade</span>
        </label>
        <label className="ml-auto flex items-center gap-2 text-[var(--muted)] cursor-pointer">
          <input
            type="checkbox"
            checked={includeFees}
            onChange={(e) => onIncludeFees(e.target.checked)}
            className="w-4 h-4 accent-[var(--accent)]"
          />
          <span>
            Include fees <span className="text-[10px]">(TopstepX commissions per side)</span>
          </span>
        </label>
      </div>

      {/* The mode's own numbers only — the other mode's are held, not shown,
          the boolean-gating convention rather than a collapsed form. */}
      {draft.mode === "fixed" ? (
        <div>
          <label htmlFor="try-contracts" className={LABEL_CLASS}>
            Contracts
          </label>
          <input
            id="try-contracts"
            type="number"
            min={1}
            step={1}
            className={`${INPUT_CLASS} w-32 font-mono tabular-nums`}
            value={draft.contracts}
            onChange={(e) => onChange({ ...draft, contracts: Number(e.target.value) })}
          />
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <div>
            <label htmlFor="try-risk-usd" className={LABEL_CLASS}>
              Risk per trade ($)
            </label>
            <input
              id="try-risk-usd"
              type="number"
              min={0}
              step={25}
              className={`${INPUT_CLASS} w-32 font-mono tabular-nums`}
              value={draft.riskUsd ?? ""}
              onChange={(e) => onChange({ ...draft, riskUsd: numberOrNull(e.target.value) })}
            />
          </div>
          <div>
            <label htmlFor="try-max-contracts" className={LABEL_CLASS}>
              Max contracts
            </label>
            <input
              id="try-max-contracts"
              type="number"
              min={1}
              step={1}
              className={`${INPUT_CLASS} w-32 font-mono tabular-nums`}
              value={draft.maxContracts}
              onChange={(e) => onChange({ ...draft, maxContracts: Number(e.target.value) })}
            />
          </div>
        </div>
      )}
      {researchNote && <p className="text-[11px] text-[var(--warning)]">{researchNote}</p>}
      {playbookLimitsNote && <p className="text-[11px] text-[var(--warning)]">{playbookLimitsNote}</p>}
    </div>
  );
}

function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Deferred so the click has dispatched before the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
