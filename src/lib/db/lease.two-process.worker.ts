// A second process for `lease.two-process.test.ts`: the real `lease.ts` on its
// own better-sqlite3 connection to the file the parent names in
// TRADING_DB_PATH, acting as `argv[2]`. It opens the database the parent has
// already created, switched to WAL and migrated, and says `ready`, then runs
// one command per message:
//
//   "go"          one `tryAcquireLease`, with how long the call blocked
//   "hold"        the same, for a process that is about to be the active
//   "yield"       the active's half of a hand-off: renew until asked, accept,
//                 drain `drainMs` still renewing, release
//   "take"        the standby's half: ask, then poll the acquire until it lands

import { getDb } from "./connection";
import {
  acceptHandoff,
  handoffRequestedBy,
  readLease,
  releaseLease,
  renewLease,
  requestHandoff,
  tryAcquireLease,
  type LeaseAttempt,
} from "./lease";

/** A throw comes back as `error`, so a broken acquire fails the test at once
 *  rather than at its timeout. */
export interface WorkerReply {
  attempt: LeaseAttempt | null;
  error: string | null;
  elapsedMs: number;
}

export interface YieldReply {
  error: string | null;
  requester: string | null;
  acceptedAt: number;
  /** The last instant this process read itself as the holder. */
  lastHeldAt: number;
  releasedAt: number;
}

export interface TakeReply {
  error: string | null;
  requestedOf: string | null;
  /** Acquires refused while the active still held a fresh lease. */
  refused: number;
  acquiredAt: number;
  generation: number;
}

export type WorkerCommand = "go" | "hold" | { op: "yield"; drainMs: number } | { op: "take" };

const POLL_MS = 5;
const holder = process.argv[2];
getDb();

const pause = (ms: number) => new Promise<void>((resolvePause) => setTimeout(resolvePause, ms));

function acquireOnce(): WorkerReply {
  const started = Date.now();
  try {
    return { attempt: tryAcquireLease(holder, Date.now()), error: null, elapsedMs: Date.now() - started };
  } catch (err) {
    return { attempt: null, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - started };
  }
}

async function yieldWhenAsked(drainMs: number): Promise<YieldReply> {
  let requester: string | null = null;
  while (requester == null) {
    renewLease(holder, Date.now());
    const asking = handoffRequestedBy(holder, Date.now());
    if (asking != null && acceptHandoff(holder, asking, Date.now())) requester = asking;
    else await pause(POLL_MS);
  }
  const acceptedAt = Date.now();
  let lastHeldAt = acceptedAt;
  while (Date.now() - acceptedAt < drainMs) {
    renewLease(holder, Date.now());
    if (readLease().holder === holder) lastHeldAt = Date.now();
    await pause(POLL_MS);
  }
  if (readLease().holder === holder) lastHeldAt = Date.now();
  releaseLease(holder);
  return { error: null, requester, acceptedAt, lastHeldAt, releasedAt: Date.now() };
}

async function takeByHandoff(): Promise<TakeReply> {
  const ask = requestHandoff(holder, Date.now());
  let refused = 0;
  for (;;) {
    const attempt = tryAcquireLease(holder, Date.now());
    if (attempt.acquired) {
      return {
        error: null,
        requestedOf: ask.kind === "requested" ? ask.holder : null,
        refused,
        acquiredAt: Date.now(),
        generation: attempt.generation,
      };
    }
    refused++;
    await pause(POLL_MS);
  }
}

process.on("message", (msg: WorkerCommand) => {
  if (msg === "go" || msg === "hold") {
    process.send?.(acquireOnce());
    return;
  }
  const run = msg.op === "yield" ? yieldWhenAsked(msg.drainMs) : takeByHandoff();
  run.then(
    (reply) => process.send?.(reply),
    (err: unknown) => process.send?.({ error: err instanceof Error ? err.message : String(err) }),
  );
});
process.send?.("ready");
