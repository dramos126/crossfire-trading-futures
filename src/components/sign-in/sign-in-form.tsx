"use client";

import { useState, type FormEvent } from "react";
import { authFailureCopy } from "@/lib/hooks/use-trading/auth-answer";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";

/**
 * What the chrome shows in place of a page when the install has a sign-in
 * account and this browser holds no session. One card, the Settings
 * blocks' shape: two fields, one line for what went wrong, the action at the
 * right edge.
 */

export const SIGN_IN_TITLE = "Sign in";
export const SIGN_IN_LEAD = "This install asks for its sign-in before it shows anything.";

const INPUT_CLASS =
  "w-full border border-[var(--card-border)] bg-[var(--bg)] px-3 py-2 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)] rounded-md transition-colors";
const LABEL_CLASS = "block text-xs font-medium text-[var(--muted)] uppercase tracking-wider";

export function SignInForm() {
  const { signIn } = useTrading();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setProblem(null);
    try {
      const failure = await signIn(username, password);
      if (failure !== null) {
        setProblem(authFailureCopy(failure));
        setPassword("");
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="border border-[var(--card-border)] bg-[var(--card)] p-4 space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--card-border)] pb-2">
        <h1 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">
          {SIGN_IN_TITLE}
        </h1>
        <p className="text-[11px] text-[var(--muted)]">{SIGN_IN_LEAD}</p>
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="sign-in-username" className={LABEL_CLASS}>
              Username
            </label>
            <input
              id="sign-in-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              spellCheck={false}
              required
              className={INPUT_CLASS}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="sign-in-password" className={LABEL_CLASS}>
              Password
            </label>
            <input
              id="sign-in-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className={INPUT_CLASS}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span role="alert" className="mr-auto text-[11px] font-mono text-[var(--danger)] min-h-[16px]">
            {problem}
          </span>
          <button
            type="submit"
            disabled={working}
            className="btn-emerald px-5 py-2 rounded-md text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {working ? "Signing in…" : SIGN_IN_TITLE}
          </button>
        </div>
      </form>
    </section>
  );
}
