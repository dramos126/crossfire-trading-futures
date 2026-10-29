"use client";

import { useState } from "react";
import { SETTINGS_FIELD_GRID } from "@/components/settings/settings-connection-controls";
import type { AccountInput } from "@/components/settings/settings-model";
import {
  PASSWORD_MIN_CHARS,
  PASSWORDS_DIFFER_PROBLEM,
  passwordProblem,
  usernameProblem,
} from "@/lib/auth/web-account-rules";
import { authFailureCopy, rateLimitedFailure } from "@/lib/hooks/use-trading/auth-answer";
import { SETUP_CODE_HINT, SETUP_CODE_MISSING_MESSAGE } from "@/lib/auth/sign-in-wire";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";

/**
 * The web sign-in's two Settings blocks: the first run's account step, and
 * *Change password* on the Sign-in page. Both are a card of fields on the
 * Connections grid, like every other block on these pages.
 */

const INPUT_CLASS =
  "w-full min-h-11 sm:min-h-0 border border-[var(--card-border)] bg-[var(--bg)] px-3 py-2 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)] rounded-md transition-colors";
const LABEL_CLASS =
  "flex items-center gap-1.5 text-xs font-medium text-[var(--muted)] uppercase tracking-wider";

export const PASSWORD_RULE_HINT = `At least ${PASSWORD_MIN_CHARS} characters. A few unrelated words make a strong one.`;

/** A line under a field: its help, or — once the field has been left — what
 *  is wrong with it. */
interface FieldNote {
  text: string;
  refusal: boolean;
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  onBlur,
  note,
}: {
  id: string;
  label: string;
  type: "text" | "password";
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  onBlur?: () => void;
  note?: FieldNote | null;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-invalid={note?.refusal === true || undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        className={INPUT_CLASS}
      />
      {note && (
        <p
          id={`${id}-note`}
          className={`text-[11px] leading-relaxed ${note.refusal ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}

type StepField = "setup-code" | "username" | "password" | "confirm";

function BlockHeader({ title, lead }: { title: string; lead: string }) {
  return (
    <div className="space-y-1 pb-2 border-b border-[var(--card-border)]">
      <h3 className="text-sm font-semibold tracking-tight text-[var(--foreground)]">{title}</h3>
      <p className="text-[11px] leading-relaxed text-[var(--muted)]">{lead}</p>
    </div>
  );
}

/**
 * The first run's account step: the card the setup screen is. Each field says
 * what is wrong with it only once it has been left, so a half-typed password
 * is not called too short; the button's refusal is the screen's. `setupCode`
 * is passed only on an install that asks for one — a broker and no account.
 */
export function AccountStepBlock({
  value,
  onChange,
  setupCode,
}: {
  value: AccountInput;
  onChange: (next: AccountInput) => void;
  setupCode?: { value: string; onChange: (next: string) => void };
}) {
  const [left, setLeft] = useState<ReadonlySet<StepField>>(() => new Set());
  const leave = (field: StepField) => setLeft((prev) => new Set(prev).add(field));
  const refusalOnceLeft = (field: StepField, problem: string | null): FieldNote | null =>
    left.has(field) && problem !== null ? { text: problem, refusal: true } : null;

  return (
    <section className="border border-[var(--card-border)] bg-[var(--card)] p-4 space-y-4">
      {setupCode && (
        <Field
          id="account-setup-code"
          label="Setup code"
          type="text"
          value={setupCode.value}
          onChange={setupCode.onChange}
          onBlur={() => leave("setup-code")}
          autoComplete="off"
          note={
            refusalOnceLeft(
              "setup-code",
              setupCode.value.trim().length === 0 ? SETUP_CODE_MISSING_MESSAGE : null,
            ) ?? { text: SETUP_CODE_HINT, refusal: false }
          }
        />
      )}
      <div className={SETTINGS_FIELD_GRID}>
        <Field
          id="account-username"
          label="Username"
          type="text"
          value={value.username}
          onChange={(username) => onChange({ ...value, username })}
          onBlur={() => leave("username")}
          autoComplete="username"
          note={refusalOnceLeft("username", usernameProblem(value.username))}
        />
        <Field
          id="account-password"
          label="Password"
          type="password"
          value={value.password}
          onChange={(password) => onChange({ ...value, password })}
          onBlur={() => leave("password")}
          autoComplete="new-password"
          note={
            refusalOnceLeft("password", passwordProblem(value.password)) ?? {
              text: PASSWORD_RULE_HINT,
              refusal: false,
            }
          }
        />
        <Field
          id="account-confirm"
          label="Password again"
          type="password"
          value={value.confirm}
          onChange={(confirm) => onChange({ ...value, confirm })}
          onBlur={() => leave("confirm")}
          autoComplete="new-password"
          note={refusalOnceLeft(
            "confirm",
            value.confirm === value.password ? null : PASSWORDS_DIFFER_PROBLEM,
          )}
        />
      </div>
    </section>
  );
}

export const CHANGE_PASSWORD_TITLE = "Change password";
export const CHANGE_PASSWORD_LEAD =
  "Needs the current password. Every other browser signed in to this install is signed out.";
export const PASSWORD_CHANGED_STAMP = "CHANGED";

type ChangePhase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

function changeRefusal(current: string, next: string, again: string): string | null {
  if (current.length === 0) return "Enter the current password.";
  return passwordProblem(next) ?? (next === again ? null : PASSWORDS_DIFFER_PROBLEM);
}

/** Answers a refused change in the same words sign-in uses for a lockout. */
async function failureMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (res.status === 429) return authFailureCopy(rateLimitedFailure(body));
  return typeof body.error === "string" ? body.error : `Could not change the password (${res.status}).`;
}

export function ChangePasswordBlock() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [phase, setPhase] = useState<ChangePhase>({ kind: "idle" });
  const refusal = changeRefusal(current, next, again);
  const working = phase.kind === "working";

  async function submit() {
    if (refusal !== null || working) return;
    setPhase({ kind: "working" });
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!res.ok) {
        setPhase({ kind: "failed", message: await failureMessage(res) });
        return;
      }
      setCurrent("");
      setNext("");
      setAgain("");
      setPhase({ kind: "done" });
    } catch (err) {
      setPhase({ kind: "failed", message: err instanceof Error ? err.message : "Request failed." });
    }
  }

  return (
    <section className="border border-[var(--card-border)] bg-[var(--card)] p-4 space-y-4">
      <BlockHeader title={CHANGE_PASSWORD_TITLE} lead={CHANGE_PASSWORD_LEAD} />
      <div className={SETTINGS_FIELD_GRID}>
        <Field
          id="password-current"
          label="Current password"
          type="password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <Field
          id="password-new"
          label="New password"
          type="password"
          value={next}
          onChange={setNext}
          autoComplete="new-password"
        />
        <Field
          id="password-again"
          label="New password again"
          type="password"
          value={again}
          onChange={setAgain}
          autoComplete="new-password"
        />
      </div>
      {phase.kind === "failed" && (
        <div
          role="alert"
          className="border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2.5 text-sm font-mono text-[var(--danger)] rounded-md"
        >
          {phase.message}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-[11px] text-[var(--muted)]">{refusal ?? PASSWORD_RULE_HINT}</span>
        {phase.kind === "done" && (
          <span className="font-mono text-[10px] px-2 py-0.5 border border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)] rounded-sm">
            {PASSWORD_CHANGED_STAMP}
          </span>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={refusal !== null || working}
          title={refusal ?? "Replace the password"}
          className="btn-emerald px-5 py-2 rounded-md text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {working ? "Saving…" : CHANGE_PASSWORD_TITLE}
        </button>
      </div>
    </section>
  );
}

export const SIGN_OUT_LEAD = "Signs this browser out. The engine keeps running.";

export function SignOutBlock() {
  const { signOut } = useTrading();
  const [working, setWorking] = useState(false);
  return (
    <section className="border border-[var(--card-border)] bg-[var(--card)] p-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-[11px] text-[var(--muted)]">{SIGN_OUT_LEAD}</span>
        <button
          type="button"
          disabled={working}
          onClick={() => {
            setWorking(true);
            void signOut().finally(() => setWorking(false));
          }}
          className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--card-border)] bg-[var(--bg)] text-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--muted)]/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {working ? "Working…" : "Sign out"}
        </button>
      </div>
    </section>
  );
}
