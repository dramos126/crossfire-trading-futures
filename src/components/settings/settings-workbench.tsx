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
  isAutoField,
  parseBrokerSchemas,
  resolveBundleValue,
  type BrokerSchema,
} from "@/components/settings/settings-credential-fields";
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
import { Lockup } from "@/components/top-nav";
import { authFailureCopy, rateLimitedFailure } from "@/lib/hooks/use-trading/auth-answer";
import { SETUP_CODE_MISSING_MESSAGE } from "@/lib/auth/sign-in-wire";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { parseSettingsBundle, type SettingsBundle } from "@/lib/settings/parse-bundle";

/**
 * `/settings/*` — the state every Settings page shares, the left menu, and
 * the first run.
 *
 * **Mounted by `app/settings/layout.tsx`, not by each page, and that is what
 * makes several pages safe.** A layout survives navigation between its
 * children, so a credential typed on Connections and a passing test are still
 * here when the operator comes back to finish setup. Pages read this state
 * through `useSettingsWorkbench`.
 *
 * **First run is a state of this page, not a separate wizard.** `/setup` is
 * deleted, and the redirect that used to point at it points here. That is
 * only safe because this page composes `AppChrome` directly rather than
 * `AppShell`: the page the guard redirects to is never wrapped by the guard.
 *
 * A first run has two arms:
 *
 * - **No sign-in account yet** — there is no session, so this renders the
 *   setup screen alone: the sign-in card and *Create sign-in*. On an install
 *   with no broker that is the whole first run; the route confirms setup with
 *   the account, and brokers are connected later on Connections. On one whose
 *   broker already resolves, the account is created alone and the browser
 *   comes back here with a session to confirm the broker.
 * - **A session, never confirmed** — credentials resolve (typically from the
 *   environment) but `setup_confirmed_at` is null. Blocks save individually
 *   and the confirm writes the one thing that is missing.
 */

// ── Load ───────────────────────────────────────────────────────────────

interface SetupPrefill {
  /** A broker and no account: the create needs the code the server printed. */
  needsSetupCode: boolean;
  /** A broker already resolves, so the account is created alone. */
  brokerResolves: boolean;
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
  "Settings could not be read. The app has no working session and no first-run answer to offer — check the engine log.";
export const CONFIRM_NEVER_LANDED = "The request never reached the server. Setup is unchanged.";

/** The unauthenticated first-run response. Validated because it is a network
 *  boundary; the schema list is how it says whether a broker resolves. */
function parsePrefill(input: unknown): SetupPrefill | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const schemas = parseBrokerSchemas(o.brokers);
  if (schemas === null) return null;
  return {
    needsSetupCode: o.needsSetupCode === true,
    brokerResolves: schemas.some((schema) => schema.isConfigured),
  };
}

/** The schema list says whether a broker is configured, and it is re-read with
 *  the bundle after every save — so the first broker saved lists Risk. */
function modeOf(bundle: SettingsBundle, schemas: readonly BrokerSchema[]): SettingsMode {
  return resolveSettingsMode(
    bundle.setupConfirmedAt ?? null,
    schemas.some((schema) => schema.isConfigured),
  );
}

// ── Form seeding ───────────────────────────────────────────────────────

function seedForms(
  schemas: readonly BrokerSchema[],
  bundle: SettingsBundle,
): Record<string, CredentialFormState> {
  const forms: Record<string, CredentialFormState> = {};
  for (const schema of schemas) {
    const values: Record<string, string> = {};
    for (const field of schema.fields) {
      values[field.key] = field.secret ? "" : (resolveBundleValue(schema.id, field.key, bundle) ?? "");
    }
    forms[schema.id] = {
      values,
      auto: buildAutoState(schema.id, bundle.tradovate),
      test: buildInitialTestState(schema.id, bundle),
    };
  }
  return forms;
}

// ── Shared state ───────────────────────────────────────────────────────

/** What every Settings page reads. Present only once there is a session — no
 *  page renders while loading or on the setup screen. */
export interface SettingsWorkbenchState {
  bundle: SettingsBundle;
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
  const { token, status, connect } = useTrading();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [forms, setForms] = useState<Record<string, CredentialFormState>>({});
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
    // deciding whether there is a session. Committing to the setup screen here
    // would flash it at a configured operator on every load.
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
            Object.keys(prev).length === 0 ? seedForms(result.schemas, result.bundle) : prev,
          );
          return;
        }
        const res = await fetch("/api/settings/setup-prefill", { signal: ac.signal });
        if (ac.signal.aborted) return;
        const prefill = res.ok ? parsePrefill(await res.json().catch(() => null)) : null;
        setLoad(prefill === null ? { kind: "error", message: LOAD_FAILED } : { kind: "cold", prefill });
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
  const sessionMode = load.kind === "session" ? modeOf(load.bundle, load.schemas) : null;
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
      if (load.kind !== "session") return;
      const schema = load.schemas.find((s) => s.id === brokerId);
      if (!schema) return;
      setForms((prev) => ({ ...prev, ...seedForms([schema], load.bundle) }));
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

  if (load.kind === "cold") return <FirstRunSetup prefill={load.prefill} />;

  const { bundle, schemas } = load;
  const mode = modeOf(bundle, schemas);

  const progress: BrokerProgress[] = schemas.map((schema) => ({
    id: schema.id,
    displayName: schema.displayName,
    inUse: brokerInUse(schema, forms[schema.id]?.values ?? {}, bundle),
    verified: forms[schema.id]?.test.kind === "passed",
  }));
  const refusal = confirmRefusal(progress)?.message ?? null;

  async function runConfirm() {
    setConfirmPhase({ kind: "working", statusText: "Saving…" });
    try {
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
      setConfirmPhase({ kind: "done" });
      // **Awaited, not fired-and-forgotten.** `/` mounts `<SetupGuard>`, which
      // reads the same status; navigating with the connect still in flight
      // can bounce the guard straight back here. `connect()` resolves after it
      // has dispatched, and it never rejects.
      await connect();
      router.replace("/");
    } catch {
      setConfirmPhase({ kind: "failed", message: CONFIRM_NEVER_LANDED });
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
    accountStatusCheck,
  };

  return (
    <PageFrame>
      {mode === "first-run" && <FirstRunHeader />}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-[160px_minmax(0,1fr)] items-start">
        <SettingsNav pages={settingsPagesFor(mode)} />
        <div className="min-w-0 space-y-8">
          <WorkbenchContext.Provider value={shared}>{children}</WorkbenchContext.Provider>

          {/* Under whichever page is open: a first run spans Connections and
              Notifications, and the confirm is the foot of both. */}
          {mode === "first-run" && (
            <ConfirmBar refusal={refusal} phase={confirmPhase} onConfirm={() => void runConfirm()} />
          )}
        </div>
      </div>
    </PageFrame>
  );
}

// ── The setup screen ───────────────────────────────────────────────────

export const FIRST_RUN_TITLE = "Set up Crossfire";
export const FIRST_RUN_LINE =
  "Brokers are connected later, in Settings. Until then you can look around, and nothing can trade.";
export const ACCOUNT_ONLY_LEAD =
  "Its broker connection is already set up. Choose a username and password; from now on Crossfire asks for them before it shows anything.";
export const CREATE_SIGN_IN_LABEL = "Create sign-in";

type CreatePhase = { kind: "idle" } | { kind: "working" } | { kind: "failed"; message: string };

/**
 * The first run with no account: the only thing on screen until it is done —
 * no menu, no broker blocks, no chrome (`AppChrome` drops it while the
 * provider says `needsSetup`). *Create sign-in* creates the account, signs in
 * with it and goes to `/`.
 */
function FirstRunSetup({ prefill }: { prefill: SetupPrefill }) {
  const router = useRouter();
  const { signIn, connect } = useTrading();
  const [account, setAccount] = useState<AccountInput>(EMPTY_ACCOUNT_INPUT);
  const [setupCode, setSetupCode] = useState("");
  const [phase, setPhase] = useState<CreatePhase>({ kind: "idle" });
  const refusal =
    (prefill.needsSetupCode && setupCode.trim().length === 0 ? SETUP_CODE_MISSING_MESSAGE : null) ??
    accountRefusal(account);
  const working = phase.kind === "working";

  async function create() {
    if (refusal !== null || working) return;
    setPhase({ kind: "working" });
    const pair = { username: account.username, password: account.password };
    try {
      const res = await fetch("/api/settings/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefill.needsSetupCode ? { account: pair, setupCode } : { account: pair }),
      });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => ({}));
        // Another browser created it first; this one signs in like any other.
        // Re-read the status first: still `needsSetup`, the guard would send
        // it back here, where setup-prefill now answers 409.
        if (res.status === 409) {
          await connect();
          router.replace("/");
          return;
        }
        const error = (data as { error?: unknown }).error;
        setPhase({
          kind: "failed",
          message:
            res.status === 429
              ? authFailureCopy(rateLimitedFailure(data))
              : typeof error === "string"
                ? error
                : `Could not create the sign-in (${res.status})`,
        });
        return;
      }
      const failure = await signIn(pair.username, pair.password);
      if (failure !== null) {
        setPhase({ kind: "failed", message: authFailureCopy(failure) });
        return;
      }
      // The guard decides what is left: the Dashboard, or Settings again with
      // a session when a broker that already resolved still needs confirming.
      router.replace("/");
    } catch {
      setPhase({ kind: "failed", message: CONFIRM_NEVER_LANDED });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Lockup />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">{FIRST_RUN_TITLE}</h1>
      <AccountStepBlock
        value={account}
        onChange={setAccount}
        setupCode={prefill.needsSetupCode ? { value: setupCode, onChange: setSetupCode } : undefined}
      />
      {phase.kind === "failed" && (
        <div
          role="alert"
          className="border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2.5 text-sm font-mono text-[var(--danger)] rounded-md"
        >
          {phase.message}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="mr-auto text-[11px] leading-relaxed text-[var(--muted)]">
          {prefill.brokerResolves ? ACCOUNT_ONLY_LEAD : FIRST_RUN_LINE}
        </p>
        <button
          type="button"
          onClick={() => void create()}
          disabled={refusal !== null || working}
          title={refusal ?? undefined}
          className="btn-emerald px-5 py-2 rounded-md text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {working ? "Working…" : CREATE_SIGN_IN_LABEL}
        </button>
      </div>
    </div>
  );
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

function FirstRunHeader() {
  return (
    <div className="border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-3 space-y-1">
      <h2 className="text-sm font-semibold tracking-tight text-[var(--foreground)]">
        Finish setting up Crossfire
      </h2>
      <p className="text-[11px] leading-relaxed text-[var(--muted)]">
        Connect at least one broker — Topstep, Tradovate, or both. Either is enough on its own.
        Test each connection you fill in, then finish setup at the foot of the page.
      </p>
    </div>
  );
}

/**
 * The confirm — the terminal action of a session first run and the only
 * thing on it that writes `setup_confirmed_at`.
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
