"use client";

import { useState } from "react";
import { FieldBadge } from "@/components/field-badge";
import {
  InsetSourceBadge,
  SETTINGS_FIELD_GRID,
  SettingsTestConnectionRow,
  type SettingsTestState,
} from "@/components/settings/settings-connection-controls";
import {
  buildCanTest,
  buildLockedFields,
  buildPlaceholder,
  buildSaveBody,
  buildTestFields,
  resolveBundleSource,
  visibleTestState,
  type BrokerSchema,
} from "@/components/settings/settings-credential-fields";
import { Tooltip } from "@/components/tooltip";
import {
  parseSettingsBundle,
  type SettingSource,
  type SettingsBundle,
} from "@/lib/settings/parse-bundle";

/**
 * One external service's credentials, generated from its schema.
 *
 * The Connections page is `schemas.map(...)`, so registering a broker adds
 * its block with no change here — that property survived the tab strip's
 * removal and is the reason a block is the unit rather than a tab.
 *
 * **Fields render inline and the block does not collapse.** Replacing a tab
 * strip with rows that expand re-introduces the nesting the change was made
 * to remove; each service's fields are visible on arrival.
 *
 * **Save is per service**, as it was per tab. One global Save across every
 * connection is a far larger blast radius, and Test Connection is per service
 * already. The exception is a first run with no session, where there is
 * nothing to write incrementally with — `bundle === null` hides Save and the
 * page's confirm is the write.
 */

const INPUT_CLASS =
  "w-full min-h-11 sm:min-h-0 border border-[var(--card-border)] bg-[var(--bg)] px-3 pr-14 py-2 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)] rounded-md transition-colors";

/** A block's editable state. The page owns it: the first run's single submit
 *  needs every block's values, and the Market Data gate needs every block's
 *  test result. */
export interface CredentialFormState {
  values: Record<string, string>;
  auto: Record<string, boolean>;
  test: SettingsTestState;
}

export interface CredentialBlockProps {
  schema: BrokerSchema;
  /** Null on a first run with no session: nothing is stored, nothing locks,
   *  and Save has no route to call. */
  bundle: SettingsBundle | null;
  token: string | null;
  state: CredentialFormState;
  onField: (key: string, value: string) => void;
  onReset: () => void;
  onTest: (next: SettingsTestState) => void;
  onSaved: (updated: SettingsBundle) => Promise<void>;
  onTestPassed: () => Promise<void>;
}

async function testConnectionForBroker(
  brokerId: string,
  token: string | null,
  fields?: Record<string, string>,
): Promise<{ ok: true; [k: string]: unknown } | { ok: false; error: string; message: string }> {
  const res = await fetch("/api/settings/test-connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brokerId, fields }),
  });
  const data = (await res.json().catch(() => ({}))) as
    | { ok: true; [k: string]: unknown }
    | { ok: false; error: string; message: string }
    | { error?: string };
  // A 409 on the unauthenticated path means the plugin already resolves
  // credentials it did not get from us — environment values on an empty
  // database. It reads as a refusal and is a dead end if treated as one: the
  // operator has no session (the env credentials do not authenticate, which
  // is why they are here), and no way to test against a value that never left
  // the environment. Passing it through is the documented escape.
  if (res.status === 409 && "error" in data && data.error === "auth") {
    return { ok: true };
  }
  if ("ok" in data) return data;
  return {
    ok: false,
    error: data.error ?? "unknown",
    message: `Test failed (${res.status})`,
  };
}

export function SettingsCredentialBlock({
  schema,
  bundle,
  token,
  state,
  onField,
  onReset,
  onTest,
  onSaved,
  onTestPassed,
}: CredentialBlockProps) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function runTest() {
    onTest({ kind: "testing" });
    try {
      const fields = buildTestFields(schema, state.values);
      const data = await testConnectionForBroker(schema.id, token, fields);
      if (data.ok) {
        onTest({ kind: "passed", at: Date.now() });
        await onTestPassed();
      } else {
        onTest({ kind: "failed", error: data.error, message: data.message });
      }
    } catch (err) {
      onTest({
        kind: "failed",
        error: "network",
        message: err instanceof Error ? err.message : "Test failed",
      });
    }
  }

  async function save() {
    if (!token || bundle === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = buildSaveBody(schema, state.values, bundle);
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
      setSavedAt(Date.now());
      await onSaved(parsed);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const saveBody = bundle === null ? {} : buildSaveBody(schema, state.values, bundle);
  const dirty = Object.keys(saveBody).length > 0;
  const lockedFields = buildLockedFields(schema.id, bundle);
  const canTest = buildCanTest(schema, state.values, bundle, state.test);
  const autoFieldError = schema.fields.find(
    (f) => state.auto[f.key] === false && (state.values[f.key] ?? "").trim().length === 0,
  );
  const configured = bundle !== null && schema.isConfigured;

  return (
    <section className="border border-[var(--card-border)] bg-[var(--card)] p-4 space-y-4">
      <div className="flex items-baseline justify-between gap-3 pb-2 border-b border-[var(--card-border)]">
        <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-[var(--foreground)]">
          {/* The tab strip's per-broker dot moves here, which is strictly more
              information: every service's state is visible at once rather than
              N dots standing for panels you cannot see. */}
          <span
            className={`inline-block w-1.5 h-1.5 shrink-0 ${
              configured ? "bg-[var(--success)]" : "bg-[var(--muted)]/40"
            }`}
            title={configured ? "Configured" : "Not configured"}
            aria-label={configured ? "configured" : "not configured"}
          />
          {/* No per-block "Optional" stamp. Either broker alone is a valid
              install — marking one optional and not the other restated a rule
              that stopped being true when Tradovate-only setups were allowed.
              The first-run header states the requirement instead. */}
          {schema.displayName}
        </h3>
        {configured && (
          <span className="font-mono text-[10px] px-2 py-0.5 border border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)] rounded-sm shrink-0">
            CONFIGURED
          </span>
        )}
      </div>

      {/* Full-width row: fields up to four across rather than one stretched
          column, with the test and Save rows under them at the row's edge. */}
      <div className="space-y-4">
        <div className={SETTINGS_FIELD_GRID}>
          {schema.fields.map((field) => {
            const locked = lockedFields.has(field.key);
            const auto = state.auto[field.key] === true;
            const autoBlank =
              state.auto[field.key] === false && (state.values[field.key] ?? "").trim().length === 0;
            const source = resolveBundleSource(schema.id, field.key, bundle);
            const wide = schema.fields.length > 3 && field.key === "tradovateDeviceId";

            return (
              <div key={field.key} className={`space-y-1.5 ${wide ? "sm:col-span-2" : ""}`}>
                <label className="flex items-center gap-1.5 text-xs font-medium text-[var(--muted)] uppercase tracking-wider">
                  {field.label}
                  {auto && <FieldBadge label="AUTO" />}
                  {!field.required && !auto && (
                    <span className="text-[10px] font-mono text-[var(--muted-secondary)] normal-case tracking-normal">
                      optional
                    </span>
                  )}
                </label>

                {locked ? (
                  <LockedFieldDisplay
                    value={field.secret ? "••••••••••••" : (state.values[field.key] ?? "")}
                    masked={field.secret}
                    source={source ?? "db"}
                  />
                ) : (
                  <div className="relative">
                    <input
                      type={field.secret ? "password" : "text"}
                      value={state.values[field.key] ?? ""}
                      onChange={(e) => onField(field.key, e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={buildPlaceholder(field, source)}
                      aria-label={`${schema.displayName} ${field.label}`}
                      className={`${INPUT_CLASS} ${
                        autoBlank ? "border-[var(--danger)]/50 focus:border-[var(--danger)]" : ""
                      }`}
                    />
                    {source && source !== "unset" && <InsetSourceBadge source={source} />}
                  </div>
                )}

                {autoBlank && (
                  <div className="text-[11px] text-[var(--danger)] font-mono leading-relaxed">
                    Cannot be empty. Reset restores the value the server filled in.
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Once per block, not once per field — it describes the whole stored
            credential set, and the Danger Zone is named rather than pointed at,
            so the sentence cannot go stale when the page is reordered. */}
        {lockedFields.size > 0 && (
          <div className="text-[11px] text-[var(--muted)] leading-relaxed">
            Saved credentials are read-only here. Replacing them means Reset configuration in
            the Danger Zone, which also clears every deployment and its trade history.
          </div>
        )}

        <SettingsTestConnectionRow
          testState={visibleTestState(state.test, dirty)}
          canTest={canTest}
          onTest={() => void runTest()}
          onReset={onReset}
          showReset
          disabled={saving}
          testButtonTitle={
            canTest
              ? `Authenticate against ${schema.displayName}`
              : `Fill the required fields to test ${schema.displayName}`
          }
        />

        {autoFieldError && (
          <div className="border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2.5 text-sm font-mono text-[var(--danger)] rounded-md">
            {autoFieldError.label} cannot be empty. Reset restores the value the server filled in.
          </div>
        )}

        {saveError && (
          <div className="border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2.5 text-sm font-mono text-[var(--danger)] rounded-md">
            {saveError}
          </div>
        )}

        {bundle !== null && (
          <div className="flex flex-wrap items-center justify-end gap-3 sm:flex-nowrap">
            {savedAt && !dirty && !saveError && (
              <span className="font-mono text-[10px] px-2 py-0.5 border border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)] rounded-sm">
                SAVED
              </span>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty || !!autoFieldError}
              className="btn-emerald w-full px-5 py-2 rounded-md text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed sm:w-auto"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function LockedFieldDisplay({
  value,
  source,
  masked = false,
}: {
  value: string;
  source: SettingSource;
  masked?: boolean;
}) {
  const label = source === "env" ? "ENV" : "DB";
  const tip = source === "env" ? "Loaded from environment variable" : "Saved in this app";
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 min-h-[34px]">
      <span
        className={`font-mono text-sm tabular ${
          masked ? "text-[var(--muted)] tracking-widest" : "text-[var(--foreground)]"
        }`}
      >
        {value}
      </span>
      {source !== "unset" && (
        <Tooltip content={tip} placement="top">
          <span
            tabIndex={0}
            className="inline-flex items-center font-mono text-[10px] px-1.5 py-0.5 border border-[var(--card-border)] bg-[var(--bg)] text-[var(--muted)] rounded-sm cursor-help shrink-0 transition-colors hover:border-[var(--muted)]/60 hover:bg-[var(--card-border)] hover:text-[var(--foreground)] focus:outline-none focus:border-[var(--accent)]"
          >
            {label}
          </span>
        </Tooltip>
      )}
    </div>
  );
}
