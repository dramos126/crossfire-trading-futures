import { getDb } from "@/lib/db/connection";
import {
  attachBookToGroup,
  clearCellUncarried,
  listBooksWithPlaybooks,
  markCellUncarried,
  listDerivedRows,
  type BookWithPlaybooks,
  type DerivedRow,
} from "@/lib/db/books";
import {
  disableGroupWithSnapshot,
  enableGroupAndRestore,
  getGroup,
  insertGroupWithLegs,
  syncLegsFromGroup,
  updateGroup,
} from "@/lib/db/deployment-groups";
import { bookNotInBuild, narrowParamsToCell } from "@/lib/trading/books/code-books";
import type { ParamValues } from "@/lib/trading/strategy-types";
import {
  findConflictingDeployment,
  listGroupLegs,
  sessionForStrategyKey,
} from "@/lib/db/deployments";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import {
  daySessionRefusalForStrategyKey,
  instrumentRefusalForStrategyKey,
} from "@/lib/trading/strategies";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import {
  groupEnableWouldRetractClose,
  type Deployment,
  type TickerSymbol,
} from "@/lib/trading/domain";
import { log } from "@/lib/logger";

const handle = engineHandle();

/**
 * Materialisation: the one function that turns books into deployments, and
 * **the only writer of a derived row**.
 *
 * The planner is pure over the book rows, the deployment rows and two
 * callbacks the caller resolves — a plan is diffable and testable, and
 * decisions taken between awaits are not. Three actions, no fourth:
 *
 *   create      book enabled, cell armed, no live derived row
 *   stand down  book disabled or cell disarmed, live derived row
 *   resume      book re-enabled or cell re-armed, paused derived row — or a
 *               cell a push carries again whose row stood down because the
 *               book had dropped it (`reCarried`)
 *
 * A retired book (removed from its account) takes none of the three; a staging
 * book this build does not register takes only the off's stand-down.
 *
 * A cell is `(ticker, playbook)` on a book, and a derived row is matched to
 * its cell by `(book, ticker, strategy_key)` — so one playbook armed on two
 * instruments is two independent rows.
 *
 * **A disarm is a pause, never a destroy.** The derived row carries the trade
 * history for what that playbook did on that account, `strategy_trades.
 * deployment_id` points at its leg, and a destroy cannot be undone or raced
 * safely against an open position from a reconciler that runs at boot. The set
 * of derived rows on an install only grows.
 */

/** One cell of a book: a playbook on one instrument. */
export interface BookCell {
  ticker: TickerSymbol;
  strategyKey: string;
}

/** A book, or one cell on a book — whichever switch the operator moved. */
export interface BookScope {
  bookId: string;
  /** Absent means the book's own switch, which covers every cell on it. */
  cell?: BookCell;
}

/** What the caller knows about the `(account, ticker, playbook)` slot. */
export type SlotVerdict =
  | { kind: "free" }
  /** A hand-made deployment holds it. It wins; nothing materialises beside it. */
  | { kind: "held"; deploymentId: string; deploymentName: string | null }
  /**
   * The armed playbook is not on this cell's ticker's shelf — unregistered, or refused
   * by its own instrument or day-session declaration — so there is no window to
   * check and nothing to materialise.
   */
  | { kind: "unregistered" };

export interface BookReconcileState {
  books: readonly BookWithPlaybooks[];
  derived: readonly DerivedRow[];
  /**
   * The switches that just went **on**. A plan is computed from transitions
   * and never from the resting state, so a `Paused` derived row under an armed
   * playbook is left alone: without that rule the per-leg `⏸` would be a
   * control that undoes itself on the next boot. Empty at boot, which is why a
   * boot resumes nothing but a `reCarried` cell — one whose stand-down the
   * reconciler itself stamped when the book dropped it.
   */
  resumed: readonly BookScope[];
  /** The live-account block, asked per account. Non-null is the refusal sentence. */
  refusalFor: (accountId: number) => string | null;
  slotVerdict: (query: {
    accountId: number;
    ticker: TickerSymbol;
    strategyKey: string;
  }) => SlotVerdict;
  /**
   * Whether resuming this derived row would retract a close in flight
   * (`groupEnableWouldRetractClose` over its legs). Asked only of a
   * `reCarried` row, the one resume with no operator route in front of it to
   * refuse first. Absent answers *yes*: such a row is then not resumed, which
   * is the conservative direction.
   */
  wouldRetractClose?: (groupId: string) => boolean;
}

export interface BookCreate extends BookCell {
  bookId: string;
  accountId: number;
  /** The cell's sizing settings, written into the new row's params; absent when the cell sets none. */
  paramValues?: Readonly<Record<string, number>>;
}

export interface BookRowAction extends BookCell {
  groupId: string;
  bookId: string;
  /** On a stand-down: the book stopped carrying the cell, so the apply stamps
   *  it (`markCellUncarried`) for a later push to resume. */
  uncarried?: boolean;
  /** On a resume: the cell carries that stamp, which the apply clears. */
  reCarried?: boolean;
  /** On a resume: the cell's sizing settings, which the apply narrows the row to. */
  paramValues?: Readonly<Record<string, number>>;
}

export interface BookConflict extends BookRowAction {
  deploymentId: string;
  deploymentName: string | null;
}

export interface BookRefusal extends BookCell {
  bookId: string;
  accountId: number;
  reason: string;
}

export interface BookPlan {
  creates: BookCreate[];
  standDowns: BookRowAction[];
  resumes: BookRowAction[];
  /** Reported, never acted on: the hand-made row keeps the slot and keeps running. */
  conflicts: Omit<BookConflict, "groupId">[];
  /** A book on a refused account stays enabled and materialises nothing. */
  refusals: BookRefusal[];
  /**
   * A resume the slot question turned away because the playbook is no longer
   * on this ticker's shelf — `calibratedFor` or the day-session declaration
   * changed while the row sat paused. Reported rather than silent, unlike the
   * create arm's identical `unregistered` skip: there is a row here, Paused,
   * on the board, with trade history, and the only door into this arm is an
   * operator turning the book back on. Logged by `runBookReconcile`.
   */
  resumeRefusals: BookRowAction[];
}

export interface BookReconcileResult {
  plan: BookPlan;
  created: Array<BookRowAction>;
  stoodDown: BookRowAction[];
  resumed: BookRowAction[];
  /** How many stand-downs left a leg closing. The nudge fires only above zero. */
  pausing: number;
  /** Resumed rows whose sizing settings were narrowed to their cell's. */
  narrowed: string[];
}

/** Both sides of the lookup go through here, so the separator is arbitrary —
 *  a colon, because the character it replaced was a stray NUL that made this
 *  file read as binary to `git diff`. */
function slotKey(bookId: string, cell: BookCell): string {
  return `${bookId}:${cell.ticker}:${cell.strategyKey}`;
}

function isResumed(resumed: readonly BookScope[], bookId: string, cell: BookCell): boolean {
  return resumed.some(
    (r) =>
      r.bookId === bookId &&
      (r.cell == null ||
        (r.cell.ticker === cell.ticker && r.cell.strategyKey === cell.strategyKey)),
  );
}

/** True when the plan writes nothing. A run that writes nothing announces nothing. */
export function bookPlanIsInert(plan: BookPlan): boolean {
  return plan.creates.length === 0 && plan.standDowns.length === 0 && plan.resumes.length === 0;
}

export function reconcileBooks(state: BookReconcileState): BookPlan {
  const plan: BookPlan = {
    creates: [],
    standDowns: [],
    resumes: [],
    conflicts: [],
    refusals: [],
    resumeRefusals: [],
  };
  const derivedByKey = new Map(state.derived.map((r) => [slotKey(r.bookId, r), r]));

  for (const book of state.books) {
    // A retired book creates and resumes nothing. Its rows need no stand-down
    // either: `retireBook`, the one writer of the stamp, requires the book off
    // and every leg settled `Paused`. A cell the book no longer carries is not
    // skipped: its link arrives here unarmed, so its row stands down.
    if (book.retiredAt != null) continue;
    // A staging book on a build that does not register it (a database copied
    // from staging). This build cannot see its cells, so every row would read
    // uncarried and the loop below would stand them all down. Left as it is,
    // like a row whose playbook the build does not register — save the
    // operator's off, the wind-down every switch keeps, which stands its live
    // rows down unstamped: the switch caused it, not the book.
    if (bookNotInBuild(book.bookKey)) {
      if (!book.enabled) {
        for (const pb of book.playbooks) {
          const cell: BookCell = { ticker: pb.ticker, strategyKey: pb.strategyKey };
          const row = derivedByKey.get(slotKey(book.id, cell));
          if (row?.enabled) plan.standDowns.push({ groupId: row.groupId, bookId: book.id, ...cell });
        }
      }
      continue;
    }
    for (const pb of book.playbooks) {
      const cell: BookCell = { ticker: pb.ticker, strategyKey: pb.strategyKey };
      const row = derivedByKey.get(slotKey(book.id, cell));
      const wanted = book.enabled && pb.armed;

      if (!row) {
        if (!wanted) continue;
        // Screened here as well as at the route, because this also runs at
        // boot with no request behind it and an account can be reclassified
        // between one boot and the next. The book's `enabled` is *not*
        // rewritten: the operator's switch is the operator's.
        const reason = state.refusalFor(book.accountId);
        if (reason != null) {
          plan.refusals.push({ bookId: book.id, accountId: book.accountId, ...cell, reason });
          continue;
        }
        const slot = state.slotVerdict({ accountId: book.accountId, ...cell });
        // A conflict is transient by design, but deleting the hand-made row
        // frees the slot without acting on it. A cell with no derived row
        // materialises at the next reconcile, which is a boot or a write on
        // some book rather than the delete; a stood-down derived row resumes
        // only on a transition of its book or playbook (bugs.md A83).
        if (slot.kind === "held") {
          plan.conflicts.push({
            bookId: book.id,
            ...cell,
            deploymentId: slot.deploymentId,
            deploymentName: slot.deploymentName,
          });
          continue;
        }
        // An armed playbook this build does not register has no window to
        // check and no module to evaluate, so there is nothing to materialise.
        // Not a refusal: the grid already draws the cell `inBuild: false` from
        // `GET /api/books`, which is where the operator meets it.
        if (slot.kind === "unregistered") continue;
        plan.creates.push({
          bookId: book.id,
          accountId: book.accountId,
          ...cell,
          ...(pb.paramValues ? { paramValues: pb.paramValues } : {}),
        });
        continue;
      }

      const action: BookRowAction = { groupId: row.groupId, bookId: book.id, ...cell };
      if (!wanted) {
        if (row.enabled) plan.standDowns.push(pb.uncarried ? { ...action, uncarried: true } : action);
        continue;
      }
      if (row.enabled) continue;
      // Asked before the slot question, not after: a resting paused row is the
      // common case at every boot, and probing each one would be a conflict
      // query per hand-paused row for an answer nothing acts on.
      const transition = isResumed(state.resumed, book.id, cell);
      // The one resume that needs no operator transition: the row stood down
      // because the book dropped the cell, and a push carries it again — an
      // added cell arrives on (operator, 2026-10-19). Its close check is here
      // because no route sits in front of a boot to refuse it.
      const reCarried =
        pb.reCarried === true && !(state.wouldRetractClose ?? (() => true))(row.groupId);
      if (!transition && !reCarried) continue;
      // The create arm's screen, for the create arm's reason: no route sits in
      // front of this resume, and the account may have been reclassified, died
      // or locked since the stand-down. The stamp stays for a later reconcile.
      if (!transition) {
        const reason = state.refusalFor(book.accountId);
        if (reason != null) {
          plan.refusals.push({ bookId: book.id, accountId: book.accountId, ...cell, reason });
          continue;
        }
      }
      // The same question the create arm asks, for the same reason: while this
      // row was paused a hand-made deployment may have taken the slot, and a
      // resume that skipped it would put two Active rows on one
      // (account, ticker, playbook) with only the engine's contract lock
      // between them.
      const slot = state.slotVerdict({ accountId: book.accountId, ...cell });
      if (slot.kind === "held") {
        plan.conflicts.push({
          bookId: book.id,
          ...cell,
          deploymentId: slot.deploymentId,
          deploymentName: slot.deploymentName,
        });
        continue;
      }
      // Unlike the create arm's silent skip, there is a row here — Paused, on
      // the board, with trade history — and the only door into this arm is an
      // operator turning the book back on. Reported so that write is not a
      // silent no-op.
      if (slot.kind === "unregistered") {
        // Silent without the operator's write, as at every boot.
        if (transition) plan.resumeRefusals.push(action);
        continue;
      }
      plan.resumes.push({
        ...action,
        ...(pb.reCarried ? { reCarried: true } : {}),
        ...(pb.paramValues ? { paramValues: pb.paramValues } : {}),
      });
    }
  }
  return plan;
}

export interface ApplyBookPlanDeps {
  /**
   * Required rather than defaulted: `disableGroupWithSnapshot`'s own
   * `() => false` is correct only for a caller that already knows every leg is
   * flat, and `Paused` is a claim the deployment *is* flat. Every caller says
   * how it answered.
   */
  inPosition: (leg: Deployment) => boolean;
}

export function emptyBookResult(plan: BookPlan): BookReconcileResult {
  return { plan, created: [], stoodDown: [], resumed: [], pausing: 0, narrowed: [] };
}

/** True when a run committed something, which is what it announces on. */
function wroteSomething(result: BookReconcileResult): boolean {
  return result.created.length + result.stoodDown.length + result.resumed.length > 0;
}

/**
 * `into` is the caller's accumulator rather than a local, so a throw partway
 * through still leaves the writes that committed visible to the `finally` that
 * has to announce them.
 */
export function applyBookPlan(
  plan: BookPlan,
  deps: ApplyBookPlanDeps,
  into: BookReconcileResult = emptyBookResult(plan),
): BookReconcileResult {
  const result = into;

  for (const create of plan.creates) {
    // One transaction over both writes: the partial unique index fires on the
    // attach, so a second materialisation of one cell throws and
    // rolls the parent back rather than leaving an unbound shell behind.
    const tx = getDb().transaction(() => {
      const { group } = insertGroupWithLegs(
        {
          name: null,
          strategyKey: create.strategyKey,
          // The cell's settings are the row's starting values; a resume never rewrites them.
          paramValues: { ...create.paramValues },
          ticker: create.ticker,
          contractId: null,
          enabled: true,
        },
        [{ accountId: create.accountId }],
      );
      attachBookToGroup(group.id, create.bookId);
      return group.id;
    });
    const groupId = tx();
    result.created.push({
      groupId,
      bookId: create.bookId,
      ticker: create.ticker,
      strategyKey: create.strategyKey,
    });
  }

  for (const standDown of plan.standDowns) {
    // Read before the write: a leg holding a position lands on `Pausing` and
    // settles to `Paused` through the closing guard, which is what the nudge
    // below is for.
    const closing = listGroupLegs(standDown.groupId).some(
      (leg) => leg.status !== "Destroying" && deps.inPosition(leg),
    );
    disableGroupWithSnapshot(standDown.groupId, deps.inPosition);
    if (standDown.uncarried) markCellUncarried(standDown.bookId, standDown.ticker, standDown.strategyKey);
    if (closing) result.pausing += 1;
    result.stoodDown.push(standDown);
  }

  for (const resume of plan.resumes) {
    // Part of the resume, before the row trades again: the cell's settings are
    // a ceiling, so a row stood down at looser settings comes back at the
    // cell's, and one the operator set lower keeps its own. One transaction,
    // so a row is never enabled at the settings it was stood down with, and
    // never enabled without the result saying so.
    const narrowed = getDb().transaction(() => {
      const didNarrow = resume.paramValues != null && narrowRowToCell(resume.groupId, resume.paramValues);
      enableGroupAndRestore(resume.groupId);
      if (resume.reCarried) clearCellUncarried(resume.bookId, resume.ticker, resume.strategyKey);
      return didNarrow;
    })();
    if (narrowed) result.narrowed.push(resume.groupId);
    result.resumed.push(resume);
  }

  return result;
}

function narrowRowToCell(groupId: string, cellParams: Readonly<Record<string, number>>): boolean {
  const group = getGroup(groupId);
  if (!group) return false;
  const narrowed = narrowParamsToCell(group.paramValues as Record<string, unknown>, cellParams);
  if (narrowed == null) return false;
  const updated = updateGroup(groupId, { paramValues: narrowed as ParamValues });
  if (updated) syncLegsFromGroup(updated);
  return true;
}

export interface RunBookReconcileOptions extends ApplyBookPlanDeps {
  resumed?: readonly BookScope[];
}

/**
 * Read the books, plan, write, and tell the engine and the browser.
 *
 * Runs at boot before the first `syncEngine`, and inside the transaction of
 * every book mutation route. **On an install with no books the plan is inert
 * and none of the three announcements fires** — a boot-time no-op that emits
 * is a second heartbeat.
 *
 * Returns before the engine has heard: the handle is async and boot needs the
 * result synchronously. A route takes {@link runBookReconcileAndAnnounce}.
 * A failed announcement here is logged, because boot has already moved on and
 * there is no caller left to throw to.
 */
export function runBookReconcile(opts: RunBookReconcileOptions): BookReconcileResult {
  return reconcileThenAnnounce(opts, (announced) => {
    announced.catch((err) => {
      log.error(
        "books",
        `The engine was not told about a book change: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });
}

/** {@link runBookReconcile} for a route: settles once the engine and the
 *  browser have been told, so the response cannot overtake them, and rejects
 *  when they could not be — the route answers 500 rather than a 200 over an
 *  engine still holding the old deployment set. */
export async function runBookReconcileAndAnnounce(opts: RunBookReconcileOptions): Promise<BookReconcileResult> {
  let announced: Promise<void> = Promise.resolve();
  try {
    return reconcileThenAnnounce(opts, (pending) => {
      announced = pending;
    });
  } finally {
    await announced;
  }
}

function reconcileThenAnnounce(
  opts: RunBookReconcileOptions,
  onAnnouncing: (announced: Promise<void>) => void,
): BookReconcileResult {
  const plan = planBooks(opts.resumed ?? []);
  reportBookPlan(plan);
  if (bookPlanIsInert(plan)) return emptyBookResult(plan);

  // The announcements are owed by what **committed**, not by the run finishing:
  // a create partway down the list can throw on the partial unique index, and
  // the rows written before it are already in the deployment set. So they sit
  // in a `finally` and the throw still propagates — boot logs it as
  // `boot_step_failed`, a route 500s — with the engine and the browser told
  // about the rows that did land. A run that committed nothing announces
  // nothing, which is the same rule as the inert plan above.
  const result = emptyBookResult(plan);
  try {
    applyBookPlan(plan, { inPosition: opts.inPosition }, result);
  } finally {
    onAnnouncing(announceBookResults([result]));
  }
  return result;
}

/**
 * Read the books and plan — the half of {@link runBookReconcile} that writes
 * and logs nothing. *Move to <book>* calls it inside its own transaction,
 * applies with {@link applyBookPlan}, and reports ({@link reportBookPlan}) and
 * announces ({@link announceBookResults}) only once that transaction has
 * committed.
 */
export function planBooks(resumed: readonly BookScope[]): BookPlan {
  return reconcileBooks({
    books: listBooksWithPlaybooks(),
    derived: listDerivedRows(),
    resumed,
    // `screenAccountsForAutoTrade` is the same screen every deploy route runs:
    // the live-account block, then the account-state gate (dead, locked, OCO).
    // No predicate of its own, and no account class read anywhere else here.
    refusalFor: (accountId) => screenAccountsForAutoTrade([accountId])?.message ?? null,
    slotVerdict: resolveSlot,
    wouldRetractClose: (groupId) =>
      listGroupLegs(groupId).some((leg) => groupEnableWouldRetractClose(leg.status)),
  });
}

/**
 * Report what a plan refused — logged, so *Move to <book>* calls it only once
 * its transaction has committed: a line naming a plan that rolled back would
 * describe something that did not happen.
 */
export function reportBookPlan(plan: BookPlan): void {
  reportAccountRefusals(plan.refusals);

  // Independent of "wrote something": nothing commits here, but the row stays
  // silently Paused on an operator write (turning the book or the playbook
  // back on), which is exactly the write the announcement rule below is not
  // about — that rule guards a boot-time no-op, and `resumed` is never
  // populated at boot.
  for (const r of plan.resumeRefusals) {
    log.event(
      "book_resume_refused",
      "db",
      `Book ${r.bookId}'s ${r.strategyKey} playbook on ${r.ticker} can't resume — it is no ` +
        `longer on that ticker's shelf, so its row (${r.groupId}) stays paused`,
    );
  }
}

/**
 * The three announcements, once, for every result that committed something —
 * and nothing at all when none did, so a run that wrote nothing is not a
 * second heartbeat.
 */
export function announceBookResults(results: readonly BookReconcileResult[]): Promise<void> {
  const wrote = results.filter(wroteSomething);
  if (wrote.length === 0) return Promise.resolve();
  for (const r of wrote) logReconcile(r.plan, r);
  // Only when a plan actually put a row into `Pausing`: a pause that wrote
  // `Paused` directly has nothing to flatten, and firing regardless would make
  // this a second heartbeat rather than a response to work being created.
  const nudge = wrote.some((r) => r.pausing > 0);
  // Rejects with the engine's failure: a route that awaits it must not answer
  // 200 over an engine still holding the old set. Only boot's synchronous
  // `runBookReconcile` catches it.
  return tellEngine(nudge);
}

async function tellEngine(nudge: boolean): Promise<void> {
  await handle.syncIfRunning();
  await handle.emitDeploymentsChanged();
  if (nudge) await handle.nudgeClosingGuard();
}

/**
 * The same checks `POST /api/groups` runs, not wider ones: the derived row is
 * an ordinary create and is subject to the conflict rule exactly as a
 * hand-made one is, and to the same two declarations.
 *
 * The declarations are asked here as well as at the arm because a module's
 * `calibratedFor` or `requiresDaySession` can change after a playbook was
 * armed, and this also runs at boot with no request behind it. A playbook the
 * declarations refuse is off this ticker's shelf, so the grid renders no cell
 * for it — which is why it lands on the silent arm rather than a reported one.
 */
function resolveSlot(query: {
  accountId: number;
  ticker: TickerSymbol;
  strategyKey: string;
}): SlotVerdict {
  const session = sessionForStrategyKey(query.strategyKey);
  if (!session) return { kind: "unregistered" };
  if (instrumentRefusalForStrategyKey(query.strategyKey, query.ticker)) {
    return { kind: "unregistered" };
  }
  if (daySessionRefusalForStrategyKey(query.strategyKey, query.ticker)) {
    return { kind: "unregistered" };
  }
  const holder = findConflictingDeployment(
    query.accountId,
    query.ticker,
    query.strategyKey,
    session,
  );
  if (!holder) return { kind: "free" };
  return { kind: "held", deploymentId: holder.id, deploymentName: holder.name };
}

/**
 * The reason last reported per refused book account, for the life of the
 * process. Bounded by the catalogue.
 */
const reportedAccountRefusals = new Map<number, string>();

/** Test seam: forget what was reported. */
export function resetReportedAccountRefusals(): void {
  reportedAccountRefusals.clear();
}

/**
 * Say once that a book creates nothing on its account, and why — keyed on the
 * account and its reason, so a boot and every book route that reconciles do not
 * repeat a standing refusal, while a new reason (the lock became a death, OCO
 * was switched off) is said again. An account no longer refused is forgotten,
 * so a later refusal is news.
 */
function reportAccountRefusals(refusals: readonly BookRefusal[]): void {
  const now = new Map<number, BookRefusal>();
  for (const r of refusals) if (!now.has(r.accountId)) now.set(r.accountId, r);
  for (const id of [...reportedAccountRefusals.keys()]) {
    if (!now.has(id)) reportedAccountRefusals.delete(id);
  }
  for (const [accountId, r] of now) {
    if (reportedAccountRefusals.get(accountId) === r.reason) continue;
    reportedAccountRefusals.set(accountId, r.reason);
    log.event(
      "book_account_refused",
      "db",
      `Book ${r.bookId} creates no deployment on account ${accountId}: ${r.reason}`,
    );
  }
}

/**
 * One line per run that wrote something. **A run that wrote nothing is silent**
 * — an inert plan carrying a standing conflict or a refused account is the
 * resting state of an install and would otherwise emit this line at every boot
 * and on every book route call. The grid is where a conflict and a refusal are
 * read; here they are context on a line about work that happened.
 */
function logReconcile(plan: BookPlan, result: BookReconcileResult): void {
  const parts = [
    `${result.created.length} created`,
    `${result.stoodDown.length} stood down`,
    `${result.resumed.length} resumed`,
  ];
  if (result.narrowed.length > 0) {
    parts.push(`${result.narrowed.length} resumed at their book's lower sizing (${result.narrowed.join(", ")})`);
  }
  if (plan.conflicts.length > 0) {
    parts.push(
      `${plan.conflicts.length} held by a hand-made deployment ` +
        `(${plan.conflicts.map((c) => c.deploymentId).join(", ")})`,
    );
  }
  if (plan.refusals.length > 0) {
    parts.push(`${plan.refusals.length} on accounts that may not be auto-traded`);
  }
  log.event("group_state_changed", "db", `books reconciled — ${parts.join(", ")}`);
}
