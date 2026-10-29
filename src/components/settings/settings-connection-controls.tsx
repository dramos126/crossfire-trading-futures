"use client";

import { Tooltip } from "@/components/tooltip";
import type { SettingSource } from "@/lib/settings/parse-bundle";

/**
 * Shared Test-Connection primitives for the Settings page. One state
 * shape and one row layout, reused by every credential block
 * (`settings-credential-block.tsx`, one per broker schema) and by
 * `market-data-block.tsx`, so a Databento probe reads identically to a
 * Topstep or Tradovate one. Extend here, not per-block — see
 * design-language.md's "shared primitives" note.
 */
/**
 * The field grid every Connections block lays its inputs on. The block spans
 * the row, so fields go up to four across rather than stretching: no input
 * outruns the eye, and the row has no empty half.
 */
export const SETTINGS_FIELD_GRID = "grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4";

export type SettingsTestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "passed"; at: number }
  | { kind: "failed"; error: string; message: string };

export function SettingsTestConnectionRow({
  testState,
  canTest,
  onTest,
  onReset,
  showReset,
  disabled,
  testButtonTitle,
}: {
  testState: SettingsTestState;
  canTest: boolean;
  onTest: () => void;
  onReset: () => void;
  showReset: boolean;
  disabled: boolean;
  testButtonTitle: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-1 sm:flex-nowrap">
      <div className="text-xs font-mono min-h-[18px]">
        {testState.kind === "passed" && (
          <span className="text-[var(--success)]">
            ✓ Verified — {new Date(testState.at).toLocaleTimeString()}
          </span>
        )}
        {testState.kind === "testing" && (
          <span className="text-[var(--muted)]">Testing…</span>
        )}
        {testState.kind === "failed" && (
          <span
            className={
              testState.error === "rate_limited"
                ? "text-[var(--amber-text)]"
                : "text-[var(--danger)]"
            }
          >
            {testState.error}: {testState.message}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {showReset && (
          <button
            type="button"
            onClick={onReset}
            disabled={disabled}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--card-border)] bg-[var(--bg)] text-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--muted)]/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Reset
          </button>
        )}
        <button
          type="button"
          onClick={onTest}
          disabled={!canTest}
          className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--card-border)] bg-[var(--bg)] text-[var(--foreground)] hover:border-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title={testButtonTitle}
        >
          {testState.kind === "testing" ? "Testing…" : "Test Connection"}
        </button>
      </div>
    </div>
  );
}

export function InsetSourceBadge({ source }: { source: SettingSource }) {
  if (source === "unset") return null;
  const label = source === "env" ? "ENV" : "DB";
  const tip =
    source === "env" ? "Loaded from environment variable" : "Saved in this app";
  return (
    <span className="absolute right-2 top-1/2 -translate-y-1/2">
      <Tooltip content={tip} placement="top">
        <span
          tabIndex={0}
          className="inline-flex items-center font-mono text-[10px] px-1.5 py-0.5 border border-[var(--card-border)] bg-[var(--bg)] text-[var(--muted)] rounded-sm cursor-help transition-colors hover:border-[var(--muted)]/60 hover:bg-[var(--card-border)] hover:text-[var(--foreground)] focus:outline-none focus:border-[var(--accent)]"
        >
          {label}
        </span>
      </Tooltip>
    </span>
  );
}
