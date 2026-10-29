// Process-global flag for the boot-time staging gate run by
// src/instrumentation.ts. Decoupling the flag into its own module lets
// both the instrumentation auto-start path and /api/engine's
// maybeAutoStart() consult the same source of truth without circular
// imports.
//
// The boot path is the only writer (calls markBootAssertionFailed when
// the staging allowlist derivation finds zero PRAC accounts, when the
// selected realtime market-data provider will not resolve, or when any
// boot-time check throws); any other code path is read-only.
//
// State semantics:
//   "pending"  — boot path hasn't run yet (e.g. prod env — there's
//                nothing to assert)
//   "passed"   — staging boot derived a non-empty PRAC-only allowlist
//                from /Account/search (every id passed isPracticeAccount
//                by construction)
//   "failed"   — staging boot found zero PRAC accounts, the realtime
//                market-data slot would not resolve, or the boot path
//                threw before it could complete
//
// maybeAutoStart treats "failed" as a hard refuse-to-start. "pending" and
// "passed" both allow start (the prod path stays "pending" forever).

type BootAssertionState = "pending" | "passed" | "failed";

interface BootAssertionGlobal {
  __topstepBootAssertion?: { state: BootAssertionState; reason: string | null };
}

function store(): BootAssertionGlobal {
  return globalThis as unknown as BootAssertionGlobal;
}

function slot(): { state: BootAssertionState; reason: string | null } {
  const g = store();
  if (!g.__topstepBootAssertion) {
    g.__topstepBootAssertion = { state: "pending", reason: null };
  }
  return g.__topstepBootAssertion;
}

export function markBootAssertionPassed(): void {
  const s = slot();
  s.state = "passed";
  s.reason = null;
}

export function markBootAssertionFailed(reason: string): void {
  const s = slot();
  s.state = "failed";
  s.reason = reason;
}

export function getBootAssertionState(): BootAssertionState {
  return slot().state;
}

export function getBootAssertionFailureReason(): string | null {
  return slot().reason;
}
