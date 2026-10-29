/**
 * The close sampler: the balance each phased account's next session is sized
 * from, taken once in the gap after the session that produced it.
 *
 * The budget an account trades tomorrow is a function of tonight's closing
 * balance ([account-phase-sizer.ts](../../orders/account-phase-sizer.ts)), and the
 * operator typing that number is the one input that can size an account **up**
 * on a typo. So the app takes it itself, from the broker's own account catalog,
 * and never from a hand-entered field.
 *
 * Three properties carry it.
 *
 * **It acts only when there is no live session.** `currentCmeSessionStart`
 * returns the *next* open throughout the 17:00–18:00 ET break and the weekend
 * gap, so "the start it returned is still in the future" is the exact test for
 * the gap — and it is the same helper the daily P&L gate and the budget
 * resolver anchor on, rather than a second wall-clock constant that could drift
 * from them. A balance read inside a live session could already carry a fill.
 * **The test is asked twice, and the second ask is the one that binds**: the
 * fan-out is a broker round trip, so the clock the write is stamped with is
 * taken after it returns rather than before it was issued.
 *
 * **A sample nobody could take is not written.** A broker arm that failed
 * contributes nothing for its own accounts (the fan-out's own failure has its
 * own voice), and an account the arm answered for with a missing or non-finite
 * balance is warned about and skipped. The catalogue's `balance` is safe to
 * default to `0` everywhere else in the app; that default is withdrawn here,
 * because a zero close reads as a busted account. **And the retry that buys
 * back a transient failure is bounded per gap** — an account no arm ever
 * answers for is never stamped, so nothing else would stop the fan-out
 * repeating every five minutes until Sunday.
 *
 * **The consequence of writing nothing is that the account sizes down.** With
 * no sample stamped for the session it is about to trade, the resolver runs the
 * lowest budget of its phase and the engine says so once
 * (`risk_phase_stale`) — a holiday, a broker outage or an engine that was down
 * at the close all land there, which is the fail-closed direction.
 *
 * A controller rather than a `*Deps` satellite for the reason
 * [engine-regime.ts](../engine-regime.ts) is one: the per-account warn anchor
 * below is written here and read nowhere else.
 */
import { currentCmeSessionStart } from "../../session/session";
import {
  BrokerKind,
  listAccountRiskPostures,
  recordSessionClose,
} from "@/lib/db/account-brokers";
import type { LogSubject } from "../engine";

/**
 * How often the sampler asks whether it is in the gap. Outside one it is a
 * wall-clock read and returns; inside one the cadence bounds only how soon
 * after the close the sample lands, and how often a transient broker failure
 * is retried before the next open.
 */
export const SESSION_CLOSE_SAMPLER_INTERVAL_MS = 300_000;

/**
 * How many fan-outs one gap is worth. At the cadence above that is roughly
 * half an hour past the close, which covers a transient arm failure at 17:05
 * without paying a fan-out every five minutes for the rest of a weekend.
 */
export const SESSION_CLOSE_SAMPLER_MAX_ATTEMPTS = 6;

/** What one account fan-out answered. Balances come only from the arms that
 *  answered; a broker in `failedBrokers` reported nothing, which is not
 *  evidence about its accounts' balances. */
export interface AccountBalanceFanOut {
  balances: ReadonlyMap<number, number>;
  failedBrokers: ReadonlySet<BrokerKind>;
}

export interface SessionCloseSamplerDeps {
  /** One `searchAccounts` fan-out through the registry, consumed as a result —
   *  the engine never calls a broker client itself
   *  ([brokers/README.md](../../../../../docs/modules/brokers/README.md)). */
  refreshAccountBalances: () => Promise<AccountBalanceFanOut>;
  logEvent: (event: string, deploymentId: string, message: string, subject?: LogSubject) => void;
  /** The engine sentinel: this line is about an account, not a deployment. */
  engineScope: string;
}

export class SessionCloseSampler {
  /**
   * Which session each account has already been warned about, so a broker that
   * keeps answering an unusable balance costs one line per gap rather than one
   * per pass. Deliberately kept across a `stop()`, as the regime controller's
   * attempt memory is: a restart in the same process should not re-say what it
   * just said.
   */
  private unsampledWarnedAt = new Map<number, string>();

  /**
   * How many fan-outs this gap has already cost, keyed by the session those
   * samples would size. The stamp makes a pass idempotent only for accounts
   * that got one; an account no arm ever answers for stays pending for the
   * whole gap, so without a bound the retry runs a registry refresh, an
   * adapter sync and a refresh-failure alert every five minutes from Friday
   * evening to Sunday. Unlike the warn anchor above this is **not** kept
   * across a `stop()`: the anchor exists so a restart does not re-say a line,
   * while this bounds an unattended loop, and an operator restarting the
   * engine mid-gap is asking for another try.
   */
  private gapAttempts: { sessionStart: string; attempts: number } | null = null;

  constructor(private deps: SessionCloseSamplerDeps) {}

  /** Drop the current gap's attempt count. `stop()`'s, beside the interval it
   *  clears. */
  resetAttempts(): void {
    this.gapAttempts = null;
  }

  async runSessionCloseSampler(now: Date = new Date()): Promise<void> {
    const sessionStart = currentCmeSessionStart(now);
    // A start at or before `now` is a session that is already trading.
    if (Date.parse(sessionStart) <= now.getTime()) return;

    const pending = listAccountRiskPostures().filter(
      (a) =>
        a.broker === BrokerKind.Topstep &&
        a.riskPhase.phase !== "off" &&
        a.eodSample.sizesSessionStart !== sessionStart,
    );
    // Nothing to sample: no account has opted in, or every one of them already
    // carries a sample stamped for the session about to open. The fan-out is
    // only paid when there is a row it would answer for.
    if (pending.length === 0) return;

    if (this.gapAttempts?.sessionStart !== sessionStart) {
      this.gapAttempts = { sessionStart, attempts: 0 };
    }
    // Out of attempts: the gap's sampling stops here and the accounts still
    // unsampled open on the lowest budget of their phase, which is where every
    // other refusal on this path already leaves them.
    if (this.gapAttempts.attempts >= SESSION_CLOSE_SAMPLER_MAX_ATTEMPTS) return;
    this.gapAttempts.attempts += 1;

    const fanOut = await this.deps.refreshAccountBalances();
    // The fan-out is a broker round trip, so the clock the write is stamped
    // with is read *after* it rather than before: a pass that opened at
    // 17:59:50 and returned at 18:00:06 read a balance the new session may
    // already have moved. Both halves of the gap test are re-asked on the
    // fresh clock — the open it names must still be ahead, and it must be the
    // same open the pass set out to size, or the sample belongs to a session
    // nobody sampled for.
    const settledAt = new Date();
    const settledStart = currentCmeSessionStart(settledAt);
    if (settledStart !== sessionStart) return;
    if (Date.parse(settledStart) <= settledAt.getTime()) return;

    for (const account of pending) {
      if (fanOut.failedBrokers.has(account.broker)) continue;
      const balance = fanOut.balances.get(account.accountId);
      if (balance == null || !Number.isFinite(balance)) {
        this.warnUnsampled(account.accountId, sessionStart, balance);
        continue;
      }
      recordSessionClose(account.accountId, { balance, sessionStart, now: settledAt });
    }
  }

  private warnUnsampled(accountId: number, sessionStart: string, balance: number | undefined): void {
    if (this.unsampledWarnedAt.get(accountId) === sessionStart) return;
    this.unsampledWarnedAt.set(accountId, sessionStart);
    this.deps.logEvent(
      "session_close_unsampled",
      this.deps.engineScope,
      `Account ${accountId} reported no usable closing balance (${balance ?? "nothing"}), so the ` +
        `app recorded no close for the session opening ${sessionStart}. It sizes at the lowest ` +
        `budget of its phase until a close is recorded.`,
      { accountId },
    );
  }
}
