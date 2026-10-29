"use client";

import { useState } from "react";
import {
  InsetSourceBadge,
  SETTINGS_FIELD_GRID,
  SettingsTestConnectionRow,
  type SettingsTestState,
} from "@/components/settings/settings-connection-controls";
import {
  parseSettingsBundle,
  type DatabentoSettingsBundle,
  type MarketDataProviderBundle,
  type SettingsBundle,
} from "@/lib/settings/parse-bundle";

// ---------------------------------------------------------------------------
// Test connection adapter — mirrors testConnectionForBroker in page.tsx,
// dispatching on `providerId` instead of `brokerId` per the shared
// /api/settings/test-connection contract.
// ---------------------------------------------------------------------------

async function testConnectionForProvider(
  providerId: string,
  token: string,
  fields?: Record<string, string>,
): Promise<{ ok: true; [k: string]: unknown } | { ok: false; error: string; message: string }> {
  const res = await fetch("/api/settings/test-connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, fields }),
  });
  const data = (await res.json().catch(() => ({}))) as
    | { ok: true; [k: string]: unknown }
    | { ok: false; error: string; message: string };
  return data;
}

function buildInitialDatabentoTestState(
  databento: DatabentoSettingsBundle,
): SettingsTestState {
  if (databento.credsValidated && databento.credsValidatedAt) {
    const ts = Date.parse(databento.credsValidatedAt);
    return { kind: "passed", at: Number.isFinite(ts) ? ts : Date.now() };
  }
  return { kind: "idle" };
}

function formatCoverageDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type MarketDataSlotId = "historical" | "realtime";

/**
 * Why a provider is disabled for a given slot. Both providers currently
 * declare `historicalBars`, so the historical branch is unreachable today
 * — kept so a future history-only-elsewhere provider doesn't ship a bare
 * greyed control. The realtime/Databento case is the live one: Databento's
 * Usage-based plan has no live-bar entitlement.
 */
function disabledReason(provider: MarketDataProviderBundle, slot: MarketDataSlotId): string {
  if (slot === "historical") {
    return `${provider.displayName} does not serve historical bars.`;
  }
  if (provider.id === "databento") {
    return "Databento's current plan has no live entitlement; live data requires Standard.";
  }
  return `${provider.displayName} does not serve live data.`;
}

// ---------------------------------------------------------------------------
// Provider slot selector — one radiogroup per slot (Historical Bars,
// Realtime). A provider whose capability for the slot is false renders
// disabled with the reason inline, never a bare greyed control.
// ---------------------------------------------------------------------------

function ProviderSlotSelector({
  slot,
  label,
  hint,
  providers,
  selected,
  onSelect,
}: {
  slot: MarketDataSlotId;
  label: string;
  hint: string;
  providers: MarketDataProviderBundle[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div>
        <label className="block text-xs font-medium text-[var(--muted)] uppercase tracking-wider">
          {label}
        </label>
        <div className="text-[11px] text-[var(--muted)] font-mono mt-0.5">{hint}</div>
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="border border-[var(--card-border)] rounded-md divide-y divide-[var(--card-border)] overflow-hidden"
      >
        {providers.map((provider, i) => {
          const capable =
            slot === "historical"
              ? provider.capabilities.historicalBars
              : provider.capabilities.liveBars;
          const isSelected = selected === provider.id;
          return (
            <button
              key={provider.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={!capable}
              onClick={() => capable && onSelect(provider.id)}
              className={`w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                i % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"
              } ${capable ? "hover:bg-[var(--hover)] cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
            >
              <span
                className={`mt-0.5 shrink-0 flex items-center justify-center w-3.5 h-3.5 border rounded-sm ${
                  isSelected ? "border-[var(--accent)]" : "border-[var(--card-border)]"
                }`}
              >
                {isSelected && <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-sm" />}
              </span>
              <span className="flex-1 min-w-0 space-y-0.5">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--foreground)]">
                    {provider.displayName}
                  </span>
                  {provider.isConfigured && (
                    <span className="font-mono text-[10px] px-1.5 py-0.5 border border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)] rounded-sm">
                      CONFIGURED
                    </span>
                  )}
                </span>
                {!capable && (
                  <span className="block text-[11px] text-[var(--muted)] font-mono leading-relaxed">
                    {disabledReason(provider, slot)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarketDataBlock
// ---------------------------------------------------------------------------

/**
 * Market Data's block in the Connections section.
 *
 * **It is not a broker, and its rows mean something different.** A credential
 * block answers *what are these credentials*; this one also carries a
 * *selection* — which provider serves the historical slot, which serves
 * realtime — that a credential block has no equivalent of. The section holds
 * two block shapes on purpose, which is coherent under its own framing: every
 * external service, its credentials, and what it serves.
 */
interface MarketDataBlockProps {
  bundle: SettingsBundle;
  token: string;
  onSaved: (updated: SettingsBundle) => Promise<void>;
  onTestPassed: () => Promise<void>;
}

export function MarketDataBlock({ bundle, token, onSaved, onTestPassed }: MarketDataBlockProps) {
  const md = bundle.marketData;
  const databentoProvider = md.providers.find((p) => p.id === "databento") ?? null;
  const databentoField =
    databentoProvider?.fields.find((f) => f.key === "databentoApiKey") ?? null;

  const [historicalSelection, setHistoricalSelection] = useState(md.historicalProviderId);
  const [realtimeSelection, setRealtimeSelection] = useState(md.realtimeProviderId);
  const [keyInput, setKeyInput] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [testState, setTestState] = useState<SettingsTestState>(() =>
    buildInitialDatabentoTestState(md.databento),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-seed from the bundle when it changes underneath us (Save success,
  // or a Test Connection triggering refreshBundle) — a
  // compare-against-previous-prop pattern rather than a useEffect. The
  // credential blocks reach the same end differently: the page owns their
  // form state and re-seeds it in `refreshBundle`. Only resets testState
  // when we're already
  // idle so an in-flight testing/failed/passed state isn't clobbered.
  const [prevBundle, setPrevBundle] = useState(bundle);
  if (bundle !== prevBundle) {
    const prevMd = prevBundle.marketData;
    setPrevBundle(bundle);
    // Only re-sync a slot from the fresh bundle when the local value still
    // matches what the PREVIOUS bundle had — i.e. the operator hasn't
    // touched it. Clicking Test Connection on the Databento key triggers
    // this same refresh path (onTestPassed -> refreshBundle), and an
    // unconditional reset here would silently discard a pending, unsaved
    // provider-slot change the moment the operator tested the key.
    setHistoricalSelection((cur) =>
      cur === prevMd.historicalProviderId ? md.historicalProviderId : cur,
    );
    setRealtimeSelection((cur) =>
      cur === prevMd.realtimeProviderId ? md.realtimeProviderId : cur,
    );
    setTestState((prev) =>
      prev.kind === "idle" ? buildInitialDatabentoTestState(md.databento) : prev,
    );
  }

  function handleKeyChange(v: string) {
    setKeyInput(v);
    if (v.length > 0) setClearKey(false);
    setTestState({ kind: "idle" });
    setSavedAt(null);
  }

  function toggleClearKey() {
    setClearKey((v) => !v);
    setKeyInput("");
    setTestState({ kind: "idle" });
    setSavedAt(null);
  }

  async function onTest() {
    if (!token || !databentoProvider) return;
    setTestState({ kind: "testing" });
    try {
      const fields = keyInput.length > 0 ? { databentoApiKey: keyInput } : undefined;
      const data = await testConnectionForProvider(databentoProvider.id, token, fields);
      if (data.ok) {
        setTestState({ kind: "passed", at: Date.now() });
        await onTestPassed();
      } else {
        setTestState({ kind: "failed", error: data.error, message: data.message });
      }
    } catch (err) {
      setTestState({
        kind: "failed",
        error: "network",
        message: err instanceof Error ? err.message : "Test failed",
      });
    }
  }

  function onReset() {
    setHistoricalSelection(md.historicalProviderId);
    setRealtimeSelection(md.realtimeProviderId);
    setKeyInput("");
    setClearKey(false);
    setTestState(buildInitialDatabentoTestState(md.databento));
    setSaveError(null);
    setSavedAt(null);
  }

  const selectionChanged =
    historicalSelection !== md.historicalProviderId ||
    realtimeSelection !== md.realtimeProviderId;
  const keyChanged = keyInput.length > 0 || clearKey;
  const dirty = selectionChanged || keyChanged;
  const canTest = testState.kind !== "testing";

  async function onSave() {
    if (!token) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = {};
      if (selectionChanged) {
        const marketData: Record<string, string> = {};
        if (historicalSelection !== md.historicalProviderId) {
          marketData.historicalProviderId = historicalSelection;
        }
        if (realtimeSelection !== md.realtimeProviderId) {
          marketData.realtimeProviderId = realtimeSelection;
        }
        body.marketData = marketData;
      }
      // Tri-state round-trip: explicit clear sends null, a typed value
      // sets it, leaving the field blank omits the key entirely so the
      // stored/env value is left alone.
      if (clearKey) body.databentoApiKey = null;
      else if (keyInput.length > 0) body.databentoApiKey = keyInput;
      if (Object.keys(body).length === 0) return;

      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        setSaveError((data as { error?: string }).error ?? `Save failed (${res.status})`);
        return;
      }
      const parsed = parseSettingsBundle(data);
      if ("error" in parsed) {
        setSaveError(`Bundle validation failed: ${parsed.error}`);
        return;
      }
      setKeyInput("");
      setClearKey(false);
      setSavedAt(Date.now());
      await onSaved(parsed);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border border-[var(--card-border)] bg-[var(--card)] p-4 space-y-6">
      {/* The header spans the row; everything under it keeps the measure every
          Settings block body keeps, left-aligned. */}
      <div className="flex items-baseline justify-between pb-2 border-b border-[var(--card-border)]">
        <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-[var(--foreground)]">
          {/* Same header dot every credential block carries, on the same
              question: is this service configured. */}
          <span
            className={`inline-block w-1.5 h-1.5 shrink-0 ${
              databentoProvider?.isConfigured
                ? "bg-[var(--success)]"
                : "bg-[var(--muted)]/40"
            }`}
            title={databentoProvider?.isConfigured ? "Configured" : "Not configured"}
            aria-label={databentoProvider?.isConfigured ? "configured" : "not configured"}
          />
          Market Data
        </h3>
      </div>

      {/* Provider selection — two independent slots, never free checkboxes;
          side by side once the row is wide enough for both. */}
      <div className="grid gap-5 grid-cols-1 lg:grid-cols-2">
        <ProviderSlotSelector
          slot="historical"
          label="Historical Bars"
          hint="Backtest, export, per-trade chart and replay."
          providers={md.providers}
          selected={historicalSelection}
          onSelect={setHistoricalSelection}
        />
        <ProviderSlotSelector
          slot="realtime"
          label="Realtime"
          hint="The trading engine, live quotes and the dev probes."
          providers={md.providers}
          selected={realtimeSelection}
          onSelect={setRealtimeSelection}
        />
      </div>

      {/* Databento credentials — schema-driven, renders only when the
          provider declares fields. Topstep's market-data provider
          declares none (it borrows its broker block's credentials), so no
          block renders for it here. */}
      {databentoProvider && databentoField && (
        <div className="space-y-4">
          <div className="flex items-baseline justify-between pb-2 border-b border-[var(--card-border)]">
            <h4 className="text-sm font-semibold tracking-tight text-[var(--foreground)]">
              Databento Credentials
              <span className="ml-2 text-[10px] font-mono uppercase text-[var(--muted)] tracking-wider">
                Optional
              </span>
            </h4>
            {databentoProvider.isConfigured && (
              <span className="font-mono text-[10px] px-2 py-0.5 border border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)] rounded-sm">
                CONFIGURED
              </span>
            )}
          </div>

          <div className={SETTINGS_FIELD_GRID}>
          <div className="space-y-1.5 sm:col-span-2">
            <label className="flex items-center gap-1.5 text-xs font-medium text-[var(--muted)] uppercase tracking-wider">
              {databentoField.label}
              <span className="text-[10px] font-mono text-[var(--muted)] normal-case tracking-normal">
                optional
              </span>
            </label>
            <div className="relative">
              <input
                type="password"
                value={keyInput}
                onChange={(e) => handleKeyChange(e.target.value)}
                disabled={clearKey}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  clearKey
                    ? "Will be cleared on save"
                    : md.databento.apiKeySource !== "unset"
                      ? "•••••• (saved — leave blank to keep)"
                      : "Enter Databento API key"
                }
                className="w-full border border-[var(--card-border)] bg-[var(--bg)] px-3 pr-14 py-2 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)] rounded-md transition-colors disabled:opacity-50"
              />
              {md.databento.apiKeySource !== "unset" && !clearKey && (
                <InsetSourceBadge source={md.databento.apiKeySource} />
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              {databentoField.envFallback && (
                <div className="text-[11px] text-[var(--muted)] font-mono leading-relaxed">
                  Falls back to {databentoField.envFallback} when unset.
                </div>
              )}
              {md.databento.hasApiKey && (
                <button
                  type="button"
                  onClick={toggleClearKey}
                  className="text-[11px] font-mono text-[var(--muted)] hover:text-[var(--danger)] underline underline-offset-2 shrink-0"
                >
                  {clearKey ? "Cancel clear" : "Clear stored key"}
                </button>
              )}
            </div>
          </div>
          </div>

          {/* credsValidated: false with hasApiKey: false is a complete,
              valid configuration — the cache serves historical bars
              without a key. Never rendered as an error or a warning. */}
          {!md.databento.hasApiKey && !clearKey && keyInput.length === 0 && (
            <div className="text-[11px] text-[var(--muted)] font-mono leading-relaxed">
              No key — historical bars only. The cache serves history without one; live
              data will need a Standard-plan key.
            </div>
          )}

          {md.databento.coverage && (
            <div className="text-[11px] text-[var(--muted)] font-mono leading-relaxed">
              Historical coverage through {formatCoverageDate(md.databento.coverage.end)} on{" "}
              {md.databento.coverage.dataset} — probed{" "}
              {new Date(md.databento.coverage.probedAt).toLocaleString()}
            </div>
          )}

          <SettingsTestConnectionRow
            testState={testState}
            canTest={canTest}
            onTest={() => void onTest()}
            onReset={onReset}
            showReset={true}
            disabled={saving}
            testButtonTitle="Probe Databento's historical entitlement"
          />
        </div>
      )}

      {saveError && (
        <div className={`border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2.5 text-sm font-mono text-[var(--danger)] rounded-md`}>
          {saveError}
        </div>
      )}

      {/* Action row — far right of the row, under the fields it saves */}
      <div className="flex items-center justify-end gap-3">
        {savedAt && !dirty && !saveError && (
          <span className="font-mono text-[10px] px-2 py-0.5 border border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)] rounded-sm">
            SAVED
          </span>
        )}
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={saving || !dirty}
          className="btn-emerald px-5 py-2 rounded-md text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}
