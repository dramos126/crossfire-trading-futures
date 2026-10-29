/**
 * The activation wait, moved off the deleted `/setup` wizard.
 *
 * The first test is the punchlist defect this move was the moment to fix:
 * the status text was computed from the loop index, which assumes every
 * iteration costs exactly the sleep. On a slow gateway each `fetch` costs real
 * time, so the text drifted further behind the truth the slower things got —
 * exactly the run where an operator is reading it.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ACTIVATION_AUTH_FAILED,
  ACTIVATION_POLL_BUDGET_MS,
  ACTIVATION_TIMEOUT,
  activationStatusText,
  pollUntilAuthed,
} from "./settings-activation";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const ACCOUNT = { username: "operator", password: "correct horse battery" };

/** What a slow gateway costs per attempt, on top of the sleep. */
const SLOW_GATEWAY_LATENCY_MS = 1_000;

/** A clock the caller advances explicitly, so a "slow gateway" is a fixture
 *  rather than a real wait. */
function fakeClock() {
  let t = 1_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("the progress text", () => {
  it("stages on elapsed wallclock, not on how many times the loop has run", () => {
    expect(activationStatusText(0)).toBe("Activating engine…");
    expect(activationStatusText(2_999)).toBe("Activating engine…");
    expect(activationStatusText(3_000)).toBe("Connecting to your broker…");
    expect(activationStatusText(6_999)).toBe("Connecting to your broker…");
    expect(activationStatusText(7_000)).toBe("Almost there…");
  });
});

describe("the activation poll", () => {
  it("signs in once with the new account, then resumes on the cookie — one session row, not one per attempt", async () => {
    const clock = fakeClock();
    const pairs: Array<unknown> = [];
    const responses = [
      jsonResponse(503, { needsSetup: true }),
      jsonResponse(200, { signedIn: true, engineReady: false }),
      jsonResponse(200, { signedIn: true, engineReady: false }),
      jsonResponse(200, { signedIn: true, engineReady: true }),
    ];
    const outcome = await pollUntilAuthed({
      onProgress: () => {},
      account: ACCOUNT,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
      fetchAuth: async (pair) => {
        pairs.push(pair);
        return responses[pairs.length - 1];
      },
    });
    expect(outcome).toEqual({ ok: true });
    expect(pairs).toEqual([ACCOUNT, ACCOUNT, undefined, undefined]);
  });

  it("finishes only when signed in *and* engineReady both arrive", async () => {
    // A token mints the moment credentials resolve; the hubs may still be in
    // handshake. Landing on the dashboard between the two reads as "Auth
    // failed" until the operator refreshes.
    const clock = fakeClock();
    const responses = [
      jsonResponse(200, { signedIn: true, engineReady: false }),
      jsonResponse(200, { signedIn: true, engineReady: true }),
    ];
    let calls = 0;
    const outcome = await pollUntilAuthed({
      onProgress: () => {},
      account: ACCOUNT,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
      fetchAuth: async () => responses[calls++],
    });
    expect(outcome).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("reports elapsed time to the caller even when each attempt is slow", async () => {
    // One second of gateway latency per attempt. On the loop-index version
    // the fourth attempt still read "Activating engine…" at seven real
    // seconds; here the text tracks the clock.
    const clock = fakeClock();
    const seen: string[] = [];
    await pollUntilAuthed({
      onProgress: (text) => seen.push(text),
      account: ACCOUNT,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
      fetchAuth: async () => {
        clock.advance(SLOW_GATEWAY_LATENCY_MS);
        return jsonResponse(503, {});
      },
    });
    expect(seen[0]).toBe("Activating engine…");
    expect(seen[seen.length - 1]).toBe("Almost there…");
  });

  it("still gives a slow host the wallclock window the attempt-bounded loop gave it", async () => {
    // The budget is not arithmetic — it is the behaviour change a wallclock
    // bound makes easy to lose. The old loop ran 20 attempts, so a second of
    // latency each still bought ~30s; a 10s budget spends that in six and
    // reports "taking longer than expected" over an activation that was
    // converging. `activateFromSettings()` on a cold container is allowlist +
    // migration + deployment fetch + SignalR handshake, which runs past 10s
    // on a slow host for real.
    const clock = fakeClock();
    let attempts = 0;
    const outcome = await pollUntilAuthed({
      onProgress: () => {},
      account: ACCOUNT,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
      fetchAuth: async () => {
        attempts += 1;
        clock.advance(SLOW_GATEWAY_LATENCY_MS);
        // The engine comes up eighteen seconds in — past where the narrowed
        // budget had already given up.
        return attempts >= 12
          ? jsonResponse(200, { signedIn: true, engineReady: true })
          : jsonResponse(503, {});
      },
    });
    expect(outcome).toEqual({ ok: true });
    expect(ACTIVATION_POLL_BUDGET_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("stops on a refusal rather than hammering the gateway with retries", async () => {
    const clock = fakeClock();
    const fetchAuth = vi.fn(async () => jsonResponse(401, { error: "auth" }));
    const outcome = await pollUntilAuthed({
      onProgress: () => {},
      account: ACCOUNT,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
      fetchAuth,
    });
    expect(outcome).toEqual({ ok: false, reason: "auth_failed", message: ACTIVATION_AUTH_FAILED });
    expect(fetchAuth).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through a network throw — a blip is not a refusal", async () => {
    const clock = fakeClock();
    let calls = 0;
    const outcome = await pollUntilAuthed({
      onProgress: () => {},
      account: ACCOUNT,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
      fetchAuth: async () => {
        calls += 1;
        if (calls === 1) throw new Error("network");
        return jsonResponse(200, { signedIn: true, engineReady: true });
      },
    });
    expect(outcome).toEqual({ ok: true });
  });

  it("gives up on the budget, and says so as a wait rather than a failure", async () => {
    const clock = fakeClock();
    const outcome = await pollUntilAuthed({
      onProgress: () => {},
      account: ACCOUNT,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
      fetchAuth: async () => jsonResponse(503, {}),
    });
    expect(outcome).toEqual({ ok: false, reason: "timeout", message: ACTIVATION_TIMEOUT });
  });
});
