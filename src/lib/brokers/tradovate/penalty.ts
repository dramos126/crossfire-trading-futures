import { log } from "@/lib/logger";
import { sendDiscordAlert } from "@/lib/notify/discord";
import {
  TradovateCaptchaLockoutError,
  TradovateCircuitOpenError,
} from "./errors";
import { hasPenaltyEnvelope, type TradovatePenaltyEnvelope } from "./types";

/**
 * Penalty-response handler + circuit breaker for the Tradovate REST
 * client. Implements the protocol documented in the integration plan
 * §3 ("Penalty-response handler design"):
 *
 *  - On a `p-time` envelope:
 *      sleep `p-time * 1000` ms, retry once with `p-ticket` injected
 *      into the request body. If the retry also returns a penalty,
 *      open the circuit and throw `TradovateCircuitOpenError`.
 *  - If a second `p-time` arrives within 10s for the same
 *      `(account, path)` key, open the circuit for 60s immediately
 *      (refuse fast — don't earn a captcha).
 *  - On `p-captcha`: fire a critical Discord alert, open the circuit
 *      for 1h, throw `TradovateCaptchaLockoutError`.
 *  - Place-order paths (`/order/placeOrder`, `/order/placeOSO`) are
 *      EXEMPT from auto-retry — a penalty after the gateway possibly
 *      queued the order would duplicate-submit. Throw immediately and
 *      let the next engine tick decide.
 *
 * Phase 7 wired Discord alerts:
 *  - `p-captcha`: critical (red) alert fires immediately, every time.
 *  - `p-time` rolling pressure: warning (yellow) alert fires when the
 *      per-`(account, endpoint)` penalty count crosses the threshold,
 *      then suppressed for 5min so a sustained storm doesn't spam.
 *
 * Imports `sendDiscordAlert` directly rather than taking it as a
 * constructor dependency — matches the convention in
 * `src/lib/trading/engine/engine.ts` and
 * `src/lib/trading/broker-access/broker-registry.ts`.
 * No tests exist on this module today, and the import edge doesn't
 * create a cycle (notify only depends on settings + logger).
 */

// Place-order path predicate. Exempt these from auto-retry on penalty;
// see the proposal §"Place-order exemption" and the mirror in
// src/lib/topstep/client.ts:393-400.
const PLACE_ORDER_PATHS = new Set<string>([
  "/order/placeOrder",
  "/order/placeOSO",
]);

function isPlaceOrderPath(path: string): boolean {
  return PLACE_ORDER_PATHS.has(path);
}

// Window during which two `p-time` penalties on the same key trigger
// the fast-trip circuit open. Keep aligned with the plan §3.
const PENALTY_WINDOW_MS = 10_000;

// Circuit open durations. 60s for repeated `p-time`, 1h for `p-captcha`.
const PTIME_CIRCUIT_MS = 60_000;
const PCAPTCHA_CIRCUIT_MS = 60 * 60 * 1000;

// Phase 7 alert tuning. The pressure-window/threshold/suppression triple
// is deliberately wider than the fast-trip window above — fast-trip
// (2 penalties in 10s) protects the broker from earning a captcha;
// the pressure alert (3 penalties in 60s, suppressed 5min) gives the
// operator visibility on rate-limit drift before it escalates.
const PRESSURE_WINDOW_MS = 60_000;
const PRESSURE_ALERT_THRESHOLD = 3;
const PRESSURE_ALERT_SUPPRESSION_MS = 5 * 60 * 1000;

// Discord embed colors. Match the existing palette in
// src/lib/notify/discord.ts (no new exports added there — the alert
// titles + severity-coloured embeds are local to penalty alerts).
const COLOR_CAPTCHA = 0xff0000; // hard red — same as COLOR_BRACKET_FAILURE
const COLOR_PENALTY_PRESSURE = 0xf5a524; // amber — distinct from captcha red

interface PenaltyEvent {
  at: number;
  pTimeSec: number | null;
}

interface CircuitState {
  openedAt: number;
  durationMs: number;
}

/**
 * Request-body shape the handler accepts. Tradovate POST bodies are
 * always JSON objects; GETs use query params and never need ticket
 * injection (the handler short-circuits on undefined body).
 */
type RequestBody = Record<string, unknown> | undefined;

/**
 * Inputs needed to retry — the handler itself doesn't open the socket;
 * it asks the caller to re-issue the same request with the optional
 * `p-ticket` injected into the body.
 */
export interface PenaltyHandlerContext {
  /** HTTP method of the original call. Used to warn when a GET is about
   *  to be retried with a `p-ticket` — `requestRaw` only attaches body
   *  on POSTs, so the ticket would be silently dropped. Prior-art and
   *  the Tradovate FAQ only document `p-ticket` on POSTs, so this case
   *  may genuinely never fire; the warn exists to surface it loudly if
   *  it ever does so we know to add ticket-via-query-string support. */
  method: "GET" | "POST";
  /** Endpoint path, used as part of the (account, path) penalty key. */
  path: string;
  /** Account scope for the call, or null for global endpoints. */
  accountId: number | null;
  /** Current request body — the handler clones + injects `p-ticket`
   *  before passing it to the retry executor. */
  body: RequestBody;
  /** Re-issues the call with the (possibly modified) body and returns
   *  the parsed JSON response. */
  retry: (body: RequestBody) => Promise<unknown>;
}

export class PenaltyResponseHandler {
  // (account, path) → list of recent p-time events. Used for both the
  // 10s fast-trip check and the 60s pressure-alert window — entries
  // are trimmed to the wider PRESSURE_WINDOW_MS so both checks read
  // from the same buffer.
  private penalties = new Map<string, PenaltyEvent[]>();
  // (account, path) → circuit state if open.
  private circuits = new Map<string, CircuitState>();
  // (account, path) → epoch-ms of the last pressure alert fired for
  // this key. Drives the 5-minute suppression so a sustained penalty
  // storm doesn't spam a channel.
  private lastPressureAlertAt = new Map<string, number>();

  /**
   * Check whether a circuit is currently open for the given key. Called
   * by the client BEFORE any HTTP attempt — refuses fast without
   * burning a request budget against an endpoint that's known to be
   * penalising.
   */
  assertCircuitClosed(path: string, accountId: number | null): void {
    const key = circuitKey(path, accountId);
    const state = this.circuits.get(key);
    if (!state) return;
    const now = Date.now();
    if (now - state.openedAt >= state.durationMs) {
      this.circuits.delete(key);
      return;
    }
    throw new TradovateCircuitOpenError(
      path,
      accountId,
      state.openedAt,
      state.durationMs,
    );
  }

  /**
   * Inspect a response body for a penalty envelope and react.
   *
   * Returns either:
   *   - `{ kind: "ok" }` if no penalty was present (caller uses the
   *     original body as-is)
   *   - `{ kind: "retried", body }` if a `p-time` retry succeeded
   *     (caller uses the retried response body)
   *
   * Throws on `p-captcha`, on a second-in-window `p-time`, on a retry
   * that also returns a penalty, and on any place-order penalty
   * (place-order is exempt from auto-retry).
   */
  async handle(
    body: unknown,
    ctx: PenaltyHandlerContext,
  ): Promise<{ kind: "ok" } | { kind: "retried"; body: unknown }> {
    if (!hasPenaltyEnvelope(body)) return { kind: "ok" };
    const env = body;

    // p-captcha is terminal regardless of path — the third-party-app
    // lockout doesn't care whether we were placing an order. Open a
    // 1h circuit, fire a critical Discord alert, and throw.
    if (typeof env["p-captcha"] === "string" && env["p-captcha"].length > 0) {
      this.openCircuit(ctx.path, ctx.accountId, PCAPTCHA_CIRCUIT_MS);
      log.event(
        "broker_locked_out",
        "tradovate.penalty",
        `p-captcha lockout — third-party app disabled for ~1h on ${ctx.path}`,
        {
          accountId: ctx.accountId,
          meta: {
            accountId: ctx.accountId,
            path: ctx.path,
            captcha: env["p-captcha"].slice(0, 16),
          },
        },
      );
      this.fireCaptchaAlert(ctx.path, ctx.accountId);
      throw new TradovateCaptchaLockoutError(ctx.path, ctx.accountId);
    }

    const pTime = typeof env["p-time"] === "number" ? env["p-time"] : null;
    const pTicket =
      typeof env["p-ticket"] === "string" ? env["p-ticket"] : null;

    if (pTime === null && pTicket === null) {
      // Envelope key was present but neither field was usable — treat
      // the body as a real response. Avoids tripping on a stray field
      // name collision.
      return { kind: "ok" };
    }

    log.event(
      "broker_penalty",
      "tradovate.penalty",
      `p-time penalty on ${ctx.path} — sleeping ${pTime ?? "?"}s before retry`,
      {
        accountId: ctx.accountId,
        meta: {
          accountId: ctx.accountId,
          path: ctx.path,
          pTimeSec: pTime,
          hasTicket: pTicket !== null,
        },
      },
    );

    // Place-order paths are exempt from auto-retry. The order may have
    // been queued at the gateway already; a retry would risk a
    // duplicate fill. Throw and let the engine's next tick decide
    // (with full position/order state in hand).
    if (isPlaceOrderPath(ctx.path)) {
      this.recordPenalty(ctx.path, ctx.accountId, pTime);
      throw new TradovateCircuitOpenError(
        ctx.path,
        ctx.accountId,
        Date.now(),
        0,
      );
    }

    // Two-in-window check BEFORE retry. If we're already on the second
    // `p-time` for this key inside the rolling window, open the
    // circuit and refuse without burning the retry attempt.
    if (this.shouldFastTrip(ctx.path, ctx.accountId)) {
      this.openCircuit(ctx.path, ctx.accountId, PTIME_CIRCUIT_MS);
      this.recordPenalty(ctx.path, ctx.accountId, pTime);
      // Fast-trip is itself a pressure signal — fire the throttled
      // pressure alert so the operator hears about the 60s lockout
      // without waiting for a third penalty.
      this.maybeFirePressureAlert(ctx.path, ctx.accountId);
      throw new TradovateCircuitOpenError(
        ctx.path,
        ctx.accountId,
        Date.now(),
        PTIME_CIRCUIT_MS,
      );
    }

    this.recordPenalty(ctx.path, ctx.accountId, pTime);
    this.maybeFirePressureAlert(ctx.path, ctx.accountId);

    if (pTime !== null && pTime > 0) {
      await sleep(pTime * 1000);
    }

    // GET retry with a p-ticket would silently drop the ticket — see
    // PenaltyHandlerContext.method. Warn loudly so production traffic
    // surfaces the case if/when Tradovate ever ticket-rate-limits a GET.
    if (ctx.method === "GET" && pTicket !== null) {
      log.warn(
        "tradovate.penalty",
        `GET retry with p-ticket — ticket will be dropped (requestRaw does not attach body on GET)`,
        {
          method: "GET",
          path: ctx.path,
          accountId: ctx.accountId,
          retryAttempt: 1,
        },
      );
    }

    const retryBody: RequestBody = ctx.body
      ? { ...ctx.body, "p-ticket": pTicket ?? undefined }
      : pTicket !== null
        ? { "p-ticket": pTicket }
        : undefined;

    const second = await ctx.retry(retryBody);
    // If the retry also returns a penalty, open the circuit and throw.
    // Don't recurse — one retry only.
    if (hasPenaltyEnvelope(second)) {
      this.openCircuit(ctx.path, ctx.accountId, PTIME_CIRCUIT_MS);
      const secondEnv = second as TradovatePenaltyEnvelope;
      const secondPTime =
        typeof secondEnv["p-time"] === "number" ? secondEnv["p-time"] : null;
      this.recordPenalty(ctx.path, ctx.accountId, secondPTime);
      if (
        typeof secondEnv["p-captcha"] === "string" &&
        secondEnv["p-captcha"].length > 0
      ) {
        // Promoted to captcha on retry — replace circuit duration with
        // the longer 1h window, fire the captcha alert, and throw.
        this.openCircuit(ctx.path, ctx.accountId, PCAPTCHA_CIRCUIT_MS);
        log.event(
          "broker_locked_out",
          "tradovate.penalty",
          `p-captcha on retry of ${ctx.path}`,
          { accountId: ctx.accountId, meta: { accountId: ctx.accountId, path: ctx.path } },
        );
        this.fireCaptchaAlert(ctx.path, ctx.accountId);
        throw new TradovateCaptchaLockoutError(ctx.path, ctx.accountId);
      }
      this.maybeFirePressureAlert(ctx.path, ctx.accountId);
      throw new TradovateCircuitOpenError(
        ctx.path,
        ctx.accountId,
        Date.now(),
        PTIME_CIRCUIT_MS,
      );
    }
    return { kind: "retried", body: second };
  }

  // ── Internals ────────────────────────────────────────────────────

  private recordPenalty(
    path: string,
    accountId: number | null,
    pTimeSec: number | null,
  ): void {
    const key = circuitKey(path, accountId);
    const list = this.penalties.get(key) ?? [];
    list.push({ at: Date.now(), pTimeSec });
    // Keep only events inside the wider pressure window — bounded
    // growth. The fast-trip check applies its own narrower 10s cutoff
    // when reading the buffer.
    const cutoff = Date.now() - PRESSURE_WINDOW_MS;
    const trimmed = list.filter((e) => e.at >= cutoff);
    this.penalties.set(key, trimmed);
  }

  private shouldFastTrip(path: string, accountId: number | null): boolean {
    const key = circuitKey(path, accountId);
    const list = this.penalties.get(key) ?? [];
    const cutoff = Date.now() - PENALTY_WINDOW_MS;
    const recent = list.filter((e) => e.at >= cutoff);
    // We're about to record this penalty (the second), so >= 1 prior
    // already-in-window event triggers fast-trip.
    return recent.length >= 1;
  }

  private openCircuit(
    path: string,
    accountId: number | null,
    durationMs: number,
  ): void {
    const key = circuitKey(path, accountId);
    this.circuits.set(key, { openedAt: Date.now(), durationMs });
  }

  /**
   * Fire the pressure alert iff the (account, endpoint) penalty count
   * inside the pressure window is at-or-above threshold AND the last
   * alert for this key fired more than the suppression window ago. The
   * suppression check prevents a sustained penalty storm from spamming
   * — one alert is enough to get the operator's attention.
   */
  private maybeFirePressureAlert(
    path: string,
    accountId: number | null,
  ): void {
    const key = circuitKey(path, accountId);
    const list = this.penalties.get(key) ?? [];
    const now = Date.now();
    const cutoff = now - PRESSURE_WINDOW_MS;
    const recent = list.filter((e) => e.at >= cutoff);
    if (recent.length < PRESSURE_ALERT_THRESHOLD) return;
    const lastAt = this.lastPressureAlertAt.get(key) ?? 0;
    if (now - lastAt < PRESSURE_ALERT_SUPPRESSION_MS) return;
    this.lastPressureAlertAt.set(key, now);
    const circuit = this.circuits.get(key);
    const circuitDesc = circuit
      ? `open for ${Math.max(0, circuit.openedAt + circuit.durationMs - now)}ms more`
      : "closed";
    const history = recent
      .slice(-10)
      .map(
        (e) =>
          `${new Date(e.at).toISOString()} (p-time=${e.pTimeSec ?? "?"}s)`,
      )
      .join("\n");
    void sendDiscordAlert({
      title: `Tradovate rate-limit pressure on ${path} (account ${accountId ?? "global"})`,
      color: COLOR_PENALTY_PRESSURE,
      timestamp: new Date(now).toISOString(),
      fields: [
        { name: "Endpoint", value: path, inline: true },
        {
          name: "Account",
          value: accountId === null ? "global" : String(accountId),
          inline: true,
        },
        {
          name: "Penalties (60s window)",
          value: String(recent.length),
          inline: true,
        },
        { name: "Circuit", value: circuitDesc, inline: true },
        { name: "Penalty history", value: history.slice(0, 1000) || "—" },
        {
          name: "Suggested action",
          value:
            "Review request volume on this endpoint — sustained pressure risks earning a p-captcha lockout.",
        },
      ],
    }).catch(() => {
      // Alert delivery is best-effort; failure must not throw out of
      // the penalty handler and break the calling request.
    });
  }

  /**
   * Fire the captcha alert. Critical severity — the lockout blocks all
   * Tradovate requests for ~1h; the operator needs to know immediately.
   * Not throttled: every captcha event is reportable. Includes the
   * recent p-time history for context on what triggered the escalation.
   */
  private fireCaptchaAlert(path: string, accountId: number | null): void {
    const key = circuitKey(path, accountId);
    const list = this.penalties.get(key) ?? [];
    const now = Date.now();
    const history = list
      .slice(-10)
      .map(
        (e) =>
          `${new Date(e.at).toISOString()} (p-time=${e.pTimeSec ?? "?"}s)`,
      )
      .join("\n");
    void sendDiscordAlert({
      title: "Tradovate API captcha kill-switch triggered",
      description:
        "Tradovate-broker deployments on the affected account are blocked for ~1 hour AND have been auto-paused (orphan-marked) by the engine. The 1h broker lockout clears itself, but paused deployments stay paused until the operator explicitly re-enables them. Topstep-broker deployments are unaffected.",
      color: COLOR_CAPTCHA,
      timestamp: new Date(now).toISOString(),
      fields: [
        { name: "Endpoint", value: path, inline: true },
        {
          name: "Account",
          value: accountId === null ? "global" : String(accountId),
          inline: true,
        },
        { name: "Lockout duration", value: "~1h (broker), sticky pause (engine)", inline: true },
        {
          name: "Recent p-time history",
          value: history.slice(0, 1000) || "(none captured before captcha)",
        },
        {
          name: "Suggested action",
          value:
            "Wait for the ~1h broker lockout to expire, then open Deployments → Detached and Edit each affected deployment to reassign it back to a live account (the orphan-clear path requires an accountId change). Also review the endpoint's request pattern to identify what tripped the kill-switch.",
        },
      ],
    }).catch(() => {
      // Alert delivery is best-effort; failure must not throw out of
      // the penalty handler and break the calling request.
    });
  }
}

function circuitKey(path: string, accountId: number | null): string {
  return `${accountId ?? "global"}:${path}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
