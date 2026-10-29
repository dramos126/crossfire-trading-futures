"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AccountStatusCheckState } from "@/components/account/account-risk-block";
import type { SettingsTestState } from "@/components/settings/settings-connection-controls";
import type { CredentialFormState } from "@/components/settings/settings-credential-block";
import {
  brokerInUse,
  buildAutoState,
  buildInitialTestState,
  buildSetupBody,
  isAutoField,
  parseBrokerSchemas,
  resolveBundleValue,
  type BrokerSchema,
} from "@/components/settings/settings-credential-fields";
import {
  ACTIVATION_TIMEOUT,
  pollUntilAuthed,
} from "@/components/settings/settings-activation";
import {
  accountRefusal,
  confirmRefusal,
  EMPTY_ACCOUNT_INPUT,
  resolveSettingsMode,
  settingsPagesFor,
  showsRisk,
  type AccountInput,
  type BrokerProgress,
  type SettingsMode,
} from "@/components/settings/settings-model";
import { SettingsNav } from "@/components/settings/settings-nav";
import { AccountStepBlock } from "@/components/settings/settings-sign-in-blocks";
import { authFailureCopy, rateLimitedFailure } from "@/lib/hooks/use-trading/auth-answer";
import { SETUP_CODE_MISSING_MESSAGE } from "@/lib/auth/sign-in-wire";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { parseSettingsBundle, type SettingsBundle } from "@/lib/settings/parse-bundle";

/**
 * `/settings/*` — the state every Settings page shares, the left menu, and
 * the first run's confirm.
 *
 * **Mounted by `app/settings/layout.tsx`, not by each page, and that is what
 * makes four pages safe.** A layout survives navigation between its children,
 * so a credential typed on Connections, a passing test, and the first-run
 * webhook typed on Notifications are all still here when the operator comes
 * back to finish setup. A per-page workbench would refetch on every menu
 * click and drop a cold-arm test result — the only record that a broker was
 * verified before anything is stored — so the confirm would refuse again.
 * Pages read this state through `useSettingsWorkbench`.
 *
 * **First run is a state of this page, not a separate wizard.** `/setup` is
 * deleted, and the redirect that used to point at it points here. That is
 * only safe because this page composes `AppChrome` directly rather than
 * `AppShell`: the page the guard redirects to is never wrapped by the guard.
 *
 * A first run has two arms, and the split is forced rather than chosen:
 *
 * - **With a session** — credentials resolve (typically from the environment
 *   on an empty database) but `setup_confirmed_at` is null. Every route is
 *   available, so blocks save individually and the confirm writes the one
 *   thing that is missing.
 * - **Without one** — nothing resolves, so `/api/settings` 401s and there is
 *   nothing to write incrementally *with*. The page runs on the two
 *   unauthenticated first-run routes and the confirm is the only write:
 *   `POST /api/settings/setup` persists every broker at once and activates
 *   the engine.
 */

// ── Load ───────────────────────────────────────────────────────────────

interface TradovateAutoFlags {
  appId: string;
  appVersion: string;
  deviceId: string;
  appIdAuto: boolean;
  appVersionAuto: boolean;
  deviceIdAuto: boolean;
}

interface SetupPrefill {
  /** The route answers 200 only while there is none, so this reads false on
   *  every prefill the page renders from; parsed rather than assumed. */
  hasAccount: boolean;
  /** A broker and no account: the confirm needs the code the server printed. */
  needsSetupCode: boolean;
  topstepUsername: string | null;
  tradovate: TradovateAutoFlags | null;
  schemas: BrokerSchema[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "session"; bundle: SettingsBundle; schemas: BrokerSchema[] }
  | { kind: "cold"; prefill: SetupPrefill };

type ConfirmPhase =
  | { kind: "idle" }
  | { kind: "working"; statusText: string }
  | { kind: "done" }
  | { kind: "failed"; message: string };

const LOAD_FAILED =
  "Settings could not be read. The app has no working broker session and no first-run credentials to offer — check the engine log.";

function parseTradovateFlags(input: unknown): TradovateAutoFlags | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  if (
    typeof o.appId !== "string" ||
    typeof o.appVersion !== "string" ||
    typeof o.deviceId !== "string" ||
    typeof o.appIdAuto !== "boolean" ||
    typeof o.appVersionAuto !== "boolean" ||
    typeof o.deviceIdAuto !== "boolean"
  ) {
    return null;
  }
  return {
    appId: o.appId,
    appVersion: o.appVersion,
    deviceId: o.deviceId,
    appIdAuto: o.appIdAuto,
    appVersionAuto: o.appVersionAuto,
    deviceIdAuto: o.deviceIdAuto,
  };
}

/** The unauthenticated first-run response. Validated because it is a network
 *  boundary and because a missing `brokers` array would render an empty page
 *  that looks like "no brokers exist". */
function parsePrefill(input: unknown): SetupPrefill | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const schemas = parseBrokerSchemas(o.brokers);
  if (schemas === null) return null;
  return {
    hasAccount: o.hasAccount === true,
    needsSetupCode: o.needsSetupCode === true,
    topstepUsername: typeof o.topstepUsername === "string" ? o.topstepUsername : null,
    tradovate: parseTradovateFlags(o.tradovate),
    schemas,
  };
}

// ── Form seeding ───────────────────────────────────────────────────────

function seedForms(
  schemas: readonly BrokerSchema[],
  bundle: SettingsBundle | null,
  prefill: SetupPrefill | null,
): Record<string, CredentialFormState> {
  const forms: Record<string, CredentialFormState> = {};
  for (const schema of schemas) {
    const values: Record<string, string> = {};
    for (const field of schema.fields) {
      if (field.secret) {
        values[field.key] = "";
        continue;
      }
      if (bundle !== null) {
        values[field.key] = resolveBundleValue(schema.id, field.key, bundle) ?? "";
        continue;
      }
      values[field.key] = coldSeed(schema.id, field.key, prefill);
    }
    forms[schema.id] = {
      values,
      auto: buildAutoState(
        schema.id,
        bundle !== null ? bundle.tradovate : (prefill?.tradovate ?? null),
      ),
      test: buildInitialTestState(schema.id, bundle),
    };
  }
  return forms;
}

function coldSeed(brokerId: string, fieldKey: string, prefill: SetupPrefill | null): string {
  if (prefill === null) return "";
  if (brokerId === "topstep" && fieldKey === "topstepUsername") {
    return prefill.topstepUsername ?? "";
  }
  if (brokerId === "tradovate" && prefill.tradovate) {
    if (fieldKey === "tradovateAppId") return prefill.tradovate.appId;
    if (fieldKey === "tradovateAppVersion") return prefill.tradovate.appVersion;
    if (fieldKey === "tradovateDeviceId") return prefill.tradovate.deviceId;
  }
  return "";
}

// ── Shared state ───────────────────────────────────────────────────────

/** What every Settings page reads. Present only once the load has settled on
 *  a session or the cold arm — no page renders while it is loading. */
export interface SettingsWorkbenchState {
  /** Null on a first run with no session. */
  bundle: SettingsBundle | null;
  schemas: readonly BrokerSchema[];
  token: string | null;
  mode: SettingsMode;
  progress: readonly BrokerProgress[];
  forms: Record<string, CredentialFormState>;
  setField: (brokerId: string, key: string, value: string) => void;
  setTest: (brokerId: string, next: SettingsTestState) => void;
  resetBroker: (brokerId: string) => void;
  /** Fold a save's own answer in, without a refetch. */
  adoptBundle: (updated: SettingsBundle) => void;
  refreshBundle: () => Promise<void>;
  /** The webhook typed on a cold first run, sent with the confirm. */
  webhookInput: string;
  setWebhookInput: (value: string) => void;
  /** The account-status check this visit fired, for the Risk list. */
  accountStatusCheck: AccountStatusCheckState;
}

/** The status check's answer, read off the wire. A body without a `failed`
 *  array is a check that cannot say every broker answered, so it reads as
 *  an error rather than as a clean one. */
function statusCheckOf(body: unknown): AccountStatusCheckState {
  const failed =
    typeof body === "object" && body !== null ? (body as { failed?: unknown }).failed : undefined;
  if (!Array.isArray(failed) || !failed.every((b) => typeof b === "string")) {
    return { kind: "error", message: "the server did not say which brokers answered" };
  }
  return { kind: "done", failed };
}

const WorkbenchContext = createContext<SettingsWorkbenchState | null>(null);

export function useSettingsWorkbench(): SettingsWorkbenchState {
  const state = useContext(WorkbenchContext);
  if (state === null) throw new Error("A Settings page rendered outside SettingsWorkbench");
  return state;
}

// ── The frame ──────────────────────────────────────────────────────────

export function SettingsWorkbench({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { token, status, connect, signIn } = useTrading();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [forms, setForms] = useState<Record<string, CredentialFormState>>({});
  const [webhookInput, setWebhookInput] = useState("");
  const [accountInput, setAccountInput] = useState<AccountInput>(EMPTY_ACCOUNT_INPUT);
  const [setupCode, setSetupCode] = useState("");
  const [confirmPhase, setConfirmPhase] = useState<ConfirmPhase>({ kind: "idle" });
  const [accountStatusCheck, setAccountStatusCheck] = useState<AccountStatusCheckState>({
    kind: "idle",
  });
  // One check per visit. The workbench lives in the layout, so a menu click
  // does not remount it, and the ref keeps a token rotation from re-firing.
  const statusCheckFiredRef = useRef(false);

  const fetchSession = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return null;
      const [bundleRes, schemasRes] = await Promise.all([
        fetch("/api/settings", { signal }),
        fetch("/api/settings/schemas", { signal }),
      ]);
      const bundleData: unknown = await bundleRes.json();
      if (!bundleRes.ok) {
        const err = (bundleData as { error?: string }).error;
        throw new Error(err ?? `Failed to load settings (${bundleRes.status})`);
      }
      const parsed = parseSettingsBundle(bundleData);
      if ("error" in parsed) throw new Error(`Bundle validation failed: ${parsed.error}`);
      if (!schemasRes.ok) {
        const errBody = (await schemasRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `Failed to load broker schemas (${schemasRes.status})`);
      }
      const schemas = parseBrokerSchemas(await schemasRes.json());
      if (schemas === null) throw new Error("Broker schema validation failed");
      return { bundle: parsed, schemas };
    },
    [token],
  );

  useEffect(() => {
    // `disconnected` / `connecting` are not answers — the provider is still
    // deciding whether there is a session. Committing to the cold arm here
    // would flash a first-run page at a configured operator on every load.
    const settled = token != null || status === "needsSetup" || status === "error";
    if (!settled) return;
    const ac = new AbortController();
    void (async () => {
      try {
        if (token) {
          const result = await fetchSession(ac.signal);
          if (!result || ac.signal.aborted) return;
          setLoad({ kind: "session", bundle: result.bundle, schemas: result.schemas });
          // Seed once. A token rotation re-runs this effect, and re-seeding
          // on it would blank a half-typed credential and reset a live test
          // result — `refreshBundle` is what folds server answers in after
          // the first load.
          setForms((prev) =>
            Object.keys(prev).length === 0 ? seedForms(result.schemas, result.bundle, null) : prev,
          );
          return;
        }
        const res = await fetch("/api/settings/setup-prefill", { signal: ac.signal });
        if (ac.signal.aborted) return;
        const prefill = res.ok ? parsePrefill(await res.json().catch(() => null)) : null;
        if (prefill === null) {
          setLoad({ kind: "error", message: LOAD_FAILED });
          return;
        }
        setLoad({ kind: "cold", prefill });
        setForms((prev) =>
          Object.keys(prev).length === 0 ? seedForms(prefill.schemas, null, prefill) : prev,
        );
      } catch (err) {
        if (ac.signal.aborted) return;
        setLoad({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load settings",
        });
      }
    })();
    return () => ac.abort();
  }, [token, status, fetchSession]);

  const refreshBundle = useCallback(async () => {
    try {
      const result = await fetchSession();
      if (!result) return;
      setLoad({ kind: "session", bundle: result.bundle, schemas: result.schemas });
      // Re-seed non-secret fields from the server's own answer, but never
      // clear a value the operator typed and has not saved: a Test Connection
      // refreshes the bundle, and a username typed before Save is not in it
      // yet.
      setForms((prev) => {
        const next = { ...prev };
        for (const schema of result.schemas) {
          const form = next[schema.id];
          if (!form) continue;
          const values = { ...form.values };
          for (const field of schema.fields) {
            if (field.secret) continue;
            const stored = resolveBundleValue(schema.id, field.key, result.bundle);
            if (stored !== null) values[field.key] = stored;
          }
          next[schema.id] = {
            values,
            auto: buildAutoState(schema.id, result.bundle.tradovate),
            // Only re-seed a test result the operator has not replaced —
            // overwriting a live passed/failed/testing state with the stored
            // flag would answer about the wrong credentials.
            test: form.test.kind === "idle" ? buildInitialTestState(schema.id, result.bundle) : form.test,
          };
        }
        return next;
      });
    } catch {
      // best-effort — the page keeps what it has
    }
  }, [fetchSession]);

  // Ask the brokers which accounts are still open, once, as soon as there is
  // a session the Risk page would render for — whichever page was opened. The
  // Risk list reads the stored answer, so it renders at once and re-reads when
  // this settles. Not aborted on unmount: the ref has already spent this
  // visit's one check, and the server records the answer either way.
  const sessionToken = load.kind === "session" ? token : null;
  const sessionMode =
    load.kind === "session" ? resolveSettingsMode(load.bundle.setupConfirmedAt ?? null) : null;
  useEffect(() => {
    if (sessionToken == null || sessionMode == null || !showsRisk(sessionMode)) return;
    if (statusCheckFiredRef.current) return;
    statusCheckFiredRef.current = true;
    setAccountStatusCheck({ kind: "checking" });
    void (async () => {
      try {
        const res = await fetch("/api/accounts/status", { method: "POST" });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const err =
            typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
          setAccountStatusCheck({
            kind: "error",
            message: typeof err === "string" ? err : `request failed (${res.status})`,
          });
          return;
        }
        setAccountStatusCheck(statusCheckOf(body));
      } catch (err) {
        setAccountStatusCheck({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, [sessionToken, sessionMode]);

  const setField = useCallback((brokerId: string, key: string, value: string) => {
    setForms((prev) => {
      const form = prev[brokerId];
      if (!form) return prev;
      return {
        ...prev,
        [brokerId]: {
          values: { ...form.values, [key]: value },
          // Typing into a server-filled field is what overrides it. Keeping
          // the default *is* the operator's choice, so the flag only clears
          // on an edit.
          auto: isAutoField(key) ? { ...form.auto, [key]: false } : form.auto,
          // Any edit invalidates the test: the result answered about the
          // values as they were.
          test: { kind: "idle" },
        },
      };
    });
  }, []);

  const setTest = useCallback((brokerId: string, next: SettingsTestState) => {
    setForms((prev) => {
      const form = prev[brokerId];
      return form ? { ...prev, [brokerId]: { ...form, test: next } } : prev;
    });
  }, []);

  const resetBroker = useCallback(
    (brokerId: string) => {
      const bundle = load.kind === "session" ? load.bundle : null;
      const prefill = load.kind === "cold" ? load.prefill : null;
      const schemas = load.kind === "session" ? load.schemas : (prefill?.schemas ?? []);
      const schema = schemas.find((s) => s.id === brokerId);
      if (!schema) return;
      setForms((prev) => ({ ...prev, ...seedForms([schema], bundle, prefill) }));
    },
    [load],
  );

  if (load.kind === "loading") {
    return (
      <PageFrame>
        <div className="text-sm text-[var(--muted)]">Loading…</div>
      </PageFrame>
    );
  }

  if (load.kind === "error") {
    return (
      <PageFrame>
        <div className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-3 text-sm font-mono text-[var(--danger)]">
          {load.message}
        </div>
      </PageFrame>
    );
  }

  const bundle = load.kind === "session" ? load.bundle : null;
  const schemas = load.kind === "session" ? load.schemas : load.prefill.schemas;
  const mode = resolveSettingsMode(bundle?.setupConfirmedAt ?? null);

  const progress: BrokerProgress[] = schemas.map((schema) => ({
    id: schema.id,
    displayName: schema.displayName,
    inUse: brokerInUse(schema, forms[schema.id]?.values ?? {}, bundle),
    verified: forms[schema.id]?.test.kind === "passed",
  }));
  // The account step shows on the cold arm until an account exists. When a
  // broker already resolves there — stored before sign-in existed, or from
  // the environment — it is the whole of first run on this arm: the account
  // is created alone, and the browser signs in and carries on with a session.
  const needsAccountStep = load.kind === "cold" && !load.prefill.hasAccount;
  const accountOnly = needsAccountStep && schemas.some((schema) => schema.isConfigured);
  const needsSetupCode = load.kind === "cold" && load.prefill.needsSetupCode;
  const refusal =
    (needsSetupCode && setupCode.trim().length === 0 ? SETUP_CODE_MISSING_MESSAGE : null) ??
    (needsAccountStep ? accountRefusal(accountInput) : null) ??
    (accountOnly ? null : (confirmRefusal(progress)?.message ?? null));
  const account = { username: accountInput.username, password: accountInput.password };

  async function createAccountAndSignIn() {
    const res = await fetch("/api/settings/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(needsSetupCode ? { account, setupCode } : { account }),
    });
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => ({}));
      // Another browser created it first; this one signs in like any other.
      if (res.status === 409) {
        router.replace("/");
        return;
      }
      const error = (data as { error?: unknown }).error;
      const message =
        res.status === 429
          ? authFailureCopy(rateLimitedFailure(data))
          : typeof error === "string"
            ? error
            : `Could not finish setup (${res.status})`;
      setConfirmPhase({ kind: "failed", message });
      return;
    }
    const failure = await signIn(account.username, account.password);
    if (failure !== null) {
      setConfirmPhase({ kind: "failed", message: authFailureCopy(failure) });
      return;
    }
    setConfirmPhase({ kind: "done" });
    // The guard decides what is left: the dashboard, or this page again
    // with a session if setup was never confirmed.
    router.replace("/");
  }

  async function runConfirm() {
    setConfirmPhase({ kind: "working", statusText: "Saving…" });
    try {
      if (accountOnly) {
        await createAccountAndSignIn();
        return;
      }
      if (bundle !== null && token) {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmSetup: true }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setConfirmPhase({ kind: "failed", message: data.error ?? `Could not finish setup (${res.status})` });
          return;
        }
      } else {
        const res = await fetch("/api/settings/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...buildSetupBody(schemas, valuesOf(forms), webhookInput), account }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          // 409 means another tab finished setup first, which is a success
          // from here — the install is configured either way.
          if (res.status === 409) {
            router.replace("/");
            return;
          }
          setConfirmPhase({
            kind: "failed",
            message: data.error ?? `Could not finish setup (${res.status})`,
          });
          return;
        }
        const outcome = await pollUntilAuthed({
          onProgress: (statusText) => setConfirmPhase({ kind: "working", statusText }),
          account,
        });
        if (!outcome.ok) {
          setConfirmPhase({ kind: "failed", message: outcome.message });
          return;
        }
      }
      setConfirmPhase({ kind: "done" });
      // The provider does not re-fire `connect()` out of `needsSetup` on its
      // own — that status only clears when the operator acts, which is now.
      //
      // **Awaited, not fired-and-forgotten.** `/` mounts `<SetupGuard>`, which
      // reads the same status; navigating with the connect still in flight
      // means the guard sees `needsSetup`, bounces back here, and the cold
      // arm's prefill route now 409s because the credentials were just
      // written — so the last thing a first run shows is the LOAD_FAILED box.
      // It self-heals, which is what made it survive. `connect()` resolves
      // after it has dispatched, and it never rejects.
      await connect();
      router.replace("/");
    } catch {
      setConfirmPhase({ kind: "failed", message: ACTIVATION_TIMEOUT });
    }
  }

  const shared: SettingsWorkbenchState = {
    bundle,
    schemas,
    token,
    mode,
    progress,
    forms,
    setField,
    setTest,
    resetBroker,
    adoptBundle: (updated) =>
      setLoad((prev) => (prev.kind === "session" ? { ...prev, bundle: updated } : prev)),
    refreshBundle,
    webhookInput,
    setWebhookInput,
    accountStatusCheck,
  };

  const confirmBar = (
    <ConfirmBar refusal={refusal} phase={confirmPhase} onConfirm={() => void runConfirm()} />
  );

  if (accountOnly) {
    return (
      <PageFrame>
        <AccountOnlyHeader />
        <AccountStepBlock
          value={accountInput}
          onChange={setAccountInput}
          setupCode={needsSetupCode ? { value: setupCode, onChange: setSetupCode } : undefined}
        />
        {confirmBar}
      </PageFrame>
    );
  }

  return (
    <PageFrame>
      {mode === "first-run" && <FirstRunHeader cold={bundle === null} />}
      {needsAccountStep && <AccountStepBlock value={accountInput} onChange={setAccountInput} />}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-[160px_minmax(0,1fr)] items-start">
        <SettingsNav pages={settingsPagesFor(mode)} />
        <div className="min-w-0 space-y-8">
          <WorkbenchContext.Provider value={shared}>{children}</WorkbenchContext.Provider>

          {/* Under whichever page is open: a first run spans Connections and
              Notifications, and the confirm is the foot of both. */}
          {mode === "first-run" && confirmBar}
        </div>
      </div>
    </PageFrame>
  );
}

function valuesOf(
  forms: Record<string, CredentialFormState>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [id, form] of Object.entries(forms)) out[id] = form.values;
  return out;
}

// ── Chrome ─────────────────────────────────────────────────────────────

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      {children}
    </div>
  );
}

function FirstRunHeader({ cold }: { cold: boolean }) {
  return (
    <div className="border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-3 space-y-1">
      <h2 className="text-sm font-semibold tracking-tight text-[var(--foreground)]">
        Finish setting up Crossfire
      </h2>
      <p className="text-[11px] leading-relaxed text-[var(--muted)]">
        Connect at least one broker — Topstep, Tradovate, or both. Either is enough on its own.
        Test each connection you fill in, then finish setup at the foot of the page.
      </p>
      {cold && (
        <p className="text-[11px] leading-relaxed text-[var(--muted)]">{FIRST_RUN_ACCOUNT_LINE}</p>
      )}
      {cold && (
        <p className="text-[11px] leading-relaxed text-[var(--muted)]">
          Credentials are stored in this app&apos;s own database. Secrets never come back over
          the network once saved.
        </p>
      )}
    </div>
  );
}

export const FIRST_RUN_ACCOUNT_LINE =
  "Choose the username and password this install will ask for. Both are needed to finish.";
export const ACCOUNT_ONLY_TITLE = "Create the sign-in for this install";
export const ACCOUNT_ONLY_LEAD =
  "Its broker connection is already set up. Choose a username and password; from now on Crossfire asks for them before it shows anything.";

/** An install whose broker resolves but which has no sign-in yet: the one
 *  thing first run still needs from it. */
function AccountOnlyHeader() {
  return (
    <div className="border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-3 space-y-1">
      <h2 className="text-sm font-semibold tracking-tight text-[var(--foreground)]">
        {ACCOUNT_ONLY_TITLE}
      </h2>
      <p className="text-[11px] leading-relaxed text-[var(--muted)]">{ACCOUNT_ONLY_LEAD}</p>
    </div>
  );
}

/**
 * The confirm — the terminal action of a first run and the only thing that
 * writes `setup_confirmed_at`.
 *
 * Without it, saving credentials leaves `<SetupGuard>` redirecting forever
 * with every credential already in place, which is the loop this whole page
 * shape exists to avoid.
 */
function ConfirmBar({
  refusal,
  phase,
  onConfirm,
}: {
  refusal: string | null;
  phase: ConfirmPhase;
  onConfirm: () => void;
}) {
  const working = phase.kind === "working";
  return (
    <div className="border border-[var(--card-border)] bg-[var(--card)] px-4 py-3 space-y-3">
      {phase.kind === "failed" && (
        <div className="border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2.5 text-sm font-mono text-[var(--danger)] rounded-md">
          {phase.message}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-[11px] text-[var(--muted)]">
          {refusal ?? "Everything checks out. Finishing setup opens the dashboard."}
        </span>
        {phase.kind === "done" && (
          <span className="font-mono text-[10px] px-2 py-0.5 border border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)] rounded-sm">
            CONNECTED
          </span>
        )}
        <button
          type="button"
          onClick={onConfirm}
          disabled={refusal !== null || working || phase.kind === "done"}
          title={refusal ?? "Write the setup confirmation and open the dashboard"}
          className="btn-emerald px-5 py-2 rounded-md text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {working ? phase.statusText : "Finish setup"}
        </button>
      </div>
    </div>
  );
}
