/**
 * The wait between "credentials written" and "the engine is up".
 *
 * `POST /api/settings/setup` fires `activateFromSettings()` and returns
 * without awaiting it — the full boot is allowlist + migration + deployment
 * fetch + start, and blocking the response on it would trade a progress
 * affordance for a hung request. So the client polls `/api/auth` until it is
 * signed in *and* `engineReady` arrives.
 *
 * **Gate the finish on `engineReady`, not on a 200.** A session mints the
 * moment credentials resolve, but the hubs the dashboard depends on may still
 * be in handshake, and landing there early surfaces as "Auth failed" until
 * the operator refreshes.
 *
 * This moved off the deleted `/setup` wizard with first run, and its status
 * text was rebuilt on a wallclock baseline on the way — see below.
 *
 * Owned by docs/modules/ui/design-language.md.
 */

export const ACTIVATION_POLL_INTERVAL_MS = 500;

/**
 * **30s, because that is what the loop this replaced actually waited.**
 *
 * The wizard's version was attempt-bounded — 20 attempts at a 500ms sleep —
 * so a second of gateway latency per attempt made it ~30s of wallclock, not
 * 10s. Rewriting the bound as wallclock is the right shape and was the point
 * of the move, but taking the sleep-only arithmetic as the number narrowed
 * the window to a third of itself: ~6 attempts under the same conditions.
 *
 * `activateFromSettings()` on a cold container is allowlist + migration +
 * deployment fetch + SignalR handshake, which legitimately runs past 10s on a
 * slow host. Giving up there tells the operator to go and read the engine log
 * for a boot that was converging. The loop exits the moment the engine
 * answers, so the budget is only ever paid by a run that was going to fail.
 *
 * It no longer spends `app_session` rows: the loop signs in once and resumes
 * on the cookie after that (see `pollUntilAuthed`).
 */
export const ACTIVATION_POLL_BUDGET_MS = 30_000;

const CONNECTING_AFTER_MS = 3_000;
const ALMOST_THERE_AFTER_MS = 7_000;

export type ActivationOutcome =
  | { ok: true }
  | { ok: false; reason: "auth_failed" | "timeout"; message: string };

export const ACTIVATION_AUTH_FAILED =
  "The broker rejected the credentials. Check them and test the connection again.";
export const ACTIVATION_TIMEOUT =
  "Engine activation is taking longer than expected. Check the engine log.";

/**
 * The progress affordance, **as a function of elapsed wallclock**.
 *
 * It used to be a function of the loop index — `Math.floor(i * interval /
 * 1000)` — which assumes every iteration costs exactly the sleep. A slow
 * gateway makes each `fetch` cost real time, so the text lagged further
 * behind the truth the slower things got: exactly the run where an operator
 * is reading it. The stages are not a mirror of engine state and do not claim
 * to be one; they exist so the wait does not read as a frozen spinner. Most
 * of a full-budget wait therefore sits in the last stage, which is the cost
 * of not inventing progress the client cannot observe.
 */
export function activationStatusText(elapsedMs: number): string {
  if (elapsedMs >= ALMOST_THERE_AFTER_MS) return "Almost there…";
  if (elapsedMs >= CONNECTING_AFTER_MS) return "Connecting to your broker…";
  return "Activating engine…";
}

export interface SignInPair {
  username: string;
  password: string;
}

interface PollDeps {
  /** Reports progress; called before each attempt. */
  onProgress: (statusText: string) => void;
  /** The account the first run just created. */
  account: SignInPair;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** With a pair, signs in; without one, resumes on the cookie. */
  fetchAuth?: (pair?: SignInPair) => Promise<Response>;
}

function postAuthRequest(pair?: SignInPair): Promise<Response> {
  return fetch("/api/auth", {
    method: "POST",
    ...(pair ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(pair) } : {}),
  });
}

/**
 * Poll `/api/auth` until the engine is up, the budget runs out, or the
 * credentials are refused.
 *
 * **Signs in once, then resumes.** The first answer that signs in sets the
 * cookie, and every attempt after it asks without the password — so a
 * session-but-no-hubs handshake, the case the `engineReady` gate exists for,
 * costs one `app_session` row rather than one per attempt.
 *
 * A non-503 failure stops the loop immediately: re-firing against credentials
 * the broker has already rejected just hammers the gateway with 401s. A
 * network throw does **not** stop it — a blip is not a refusal, and latching
 * on one costs a flaky connection its chance to converge.
 */
export async function pollUntilAuthed({
  onProgress,
  account,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchAuth = postAuthRequest,
}: PollDeps): Promise<ActivationOutcome> {
  const startedAt = now();
  let signedIn = false;
  for (;;) {
    const elapsed = now() - startedAt;
    if (elapsed >= ACTIVATION_POLL_BUDGET_MS) break;
    onProgress(activationStatusText(elapsed));
    await sleep(ACTIVATION_POLL_INTERVAL_MS);
    try {
      const res = await fetchAuth(signedIn ? undefined : account);
      const data = (await res.json().catch(() => ({}))) as {
        signedIn?: unknown;
        engineReady?: unknown;
        signInRequired?: unknown;
      };
      if (res.ok) {
        if (data.signedIn === true) signedIn = true;
        if (signedIn && data.engineReady === true) return { ok: true };
        continue;
      }
      // The cookie did not stick; sign in again rather than give up.
      if (data.signInRequired === true) {
        signedIn = false;
        continue;
      }
      // Still bootstrapping — the engine has not picked up the new
      // credentials yet, or the hubs are mid-handshake.
      if (res.status === 503) continue;
      return { ok: false, reason: "auth_failed", message: ACTIVATION_AUTH_FAILED };
    } catch {
      // A blip, not a refusal.
    }
  }
  return { ok: false, reason: "timeout", message: ACTIVATION_TIMEOUT };
}
