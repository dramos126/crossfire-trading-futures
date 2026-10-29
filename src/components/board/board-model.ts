/**
 * The Dashboard board's view model — **a direct read of one row shape,
 * grouped two ways.**
 *
 * It was written as an adapter over two shapes (a group with legs, and a
 * standalone deployment) so the board could be built before the model
 * changed. The model changed: every deployment is a parent with N legs,
 * this file joins the two tables, and **not one field of its output moved**
 * — which is what phase 1's adapter was for.
 *
 * **The second grouping arrived with books (2026-09-15) and it is temporary
 * by construction.** A row carrying `deployment_groups.book_id` groups by
 * *book* — one card per account, one row per armed `(ticker, playbook)` cell —
 * and every row whose `book_id` is null keeps today's grouping beside it, so
 * a hand-made deployment renders exactly as it did. When the subtractive
 * phase leaves no `book_id IS NULL` rows, the second branch has no input.
 * **It is asked for rather than assumed**: `groupByBook` is off by default,
 * because the drill-in and the editor consume this same adapter and their
 * page is *one deployment's* history — see {@link BoardInput.groupByBook}.
 *
 * **The two-valued branches that survive are about a broken row, not about
 * a second shape.** `target.kind === "deployment"`, the `switchOn` fallback
 * and `owner = group ?? deployment` all now mean *this leg's parent is
 * gone* — a soft-delete cascade caught mid-flight. That row still renders,
 * because a live row missing from the board is the failure the board exists
 * to prevent, and its ⏸ and ✕ point at the only routes that can act on it.
 * **Its ✎ points nowhere and says so** — `editHref` is null there, because
 * the editor resolves a leg up to the parent this target exists for the
 * absence of. Do not read any of it as the standalone shape; there is no
 * standalone shape.
 *
 * It is a pure function over data that already exists — no fetching, no
 * hooks, no React. Same pattern as `deployment-status.ts` and
 * `trade-markers.ts`, and for the same reason: every decision below is
 * worth a test and none of them needs a DOM.
 *
 * Three properties this file exists to hold:
 *
 *   - **A card says what its own controls act on, and never makes the
 *     component work it out.** `target` names the lifecycle surface ⏸ and ✕
 *     address and `editHref` is derived from it; `switchOn` gives ⏸ its
 *     direction. Without them a card's only routes to the surface its
 *     controls act on are `legs.length > 1`, which is wrong for a one-leg
 *     deployment, and reaching past this adapter to a raw row, which
 *     design-language.md forbids outright.
 *   - **A card states no contract count, and a leg states the budget behind
 *     the one it will take.** The count went with `resolveDeploymentSize` —
 *     the risk sizer answers it per entry from the account's budget and that
 *     signal's stop, so there is nothing here to state ahead of a signal and
 *     an invented number would be the exact defect the old `size: null` arm
 *     existed to avoid. What the operator lost with it was *how much is at
 *     risk*, and `BoardLeg.risk` is the honest version of that question: an
 *     account's per-entry budget, **on the surface that names the account**,
 *     never folded. On a book card that surface is the header — one account,
 *     one figure, no arithmetic — so `BoardDeployment.risk` carries it and the
 *     rows carry none. Exactly one of the two is populated per card.
 *   - **P&L is session-scoped and arrives from `useLivePnL`'s selectors.**
 *     Every field carrying money is named `sessionPnl` so a caller handing
 *     it an all-time breakdown is visibly lying rather than quietly wrong,
 *     and it is nullable for a related reason: a plausible `$0.00` on the
 *     field that says how much you are up or down is a specific claim the
 *     surface cannot stand behind.
 *
 * **The session strip is not a fold of this board.** Summing `sessionPnl`
 * across cards double-counts unrealized the moment two cards map to one
 * broker position, which is exactly the case `useLivePnL` dedupes by
 * `(accountId, contractId)` — and `openPositionCount` counts legs, not
 * positions, for the same reason. A page-level total reads `allAccounts()`
 * or `account(id)` from the same hook and never reduces the cards.
 */

import { deriveDeploymentStatus, type DeploymentStatusChip } from "@/components/deployment/deployment-status";
import type { PnLBreakdown } from "@/lib/hooks/use-live-pnl";
import type { TradeStatus } from "@/lib/db/trade-types";
import type {
  AccountTradingIdentity,
  AutoTradeVerdict,
} from "@/lib/trading/broker-access/account-trading-policy";
import { accountAutoTrade } from "@/lib/hooks/use-trading/account-row";
import type { ActivationTarget } from "@/lib/trading/activation-prompts";
import type { Deployment, DeploymentGroup, DeploymentStatus, TickerSymbol } from "@/lib/trading/domain";
import { formatDeploymentChips } from "@/lib/trading/orders/brackets";
import {
  resolveTimeframe,
  type MainSession,
  type ParamValues,
  type StrategyIntent,
} from "@/lib/trading/strategy-types";

/** An account as the client catalogue knows it. `AccountRow` satisfies this. */
export interface BoardAccount extends AccountTradingIdentity {
  id: number;
  /** The server's verdict, off `/api/accounts` (bugs.md A38). */
  autoTrade: AutoTradeVerdict;
}

/** What the board reads off a strategy module. Passed in rather than looked
 *  up, because the strategy loader is a build-time `require.context` with no
 *  test-environment equivalent. */
export interface BoardStrategy {
  name: string;
  timeframe: string;
  /** The playbook's own trading window — `config.session`. The card prints
   *  it; the deployment carries none. */
  session: MainSession;
  /** `config.intent`, verbatim — guidance for the badge, never a gate. See
   *  `StrategyConfig.intent`'s doc comment. */
  intent?: ReadonlyArray<StrategyIntent>;
}

/** The minimum of a `StrategyTrade` the board reads. */
export interface BoardTrade {
  deploymentId: string;
  status: TradeStatus;
}

declare const BOARD_SESSION_PNL: unique symbol;

/**
 * The session-P&L selector `buildBoard` takes, **branded so the only thing
 * that can produce one is `boardSessionPnl`** in
 * [board-view.ts](./board-view.ts).
 *
 * The brand is the point and it is not decoration. `useLivePnL(...).deployment`
 * is `(id: string) => PnLBreakdown` — no `| null` — and that is assignable to
 * a bare `(id: string) => PnLBreakdown | null`, so `sessionPnl:
 * livePnl.deployment` compiles, type-checks, renders, and passes every test
 * in this repo while reporting **every detached and practice-filtered
 * account as flat**: that selector answers an *empty breakdown* for anything
 * outside `visibleAccounts`, structurally identical to a genuine zero. The
 * wrapper is the whole em-dash guarantee and it was one untyped wiring line
 * that a plausible simplification deletes. Now deleting it does not compile.
 *
 * The brand exists only in the type system — `boardSessionPnl` asserts it
 * once, on the function it just built, and nothing is added at runtime. A
 * test that needs a fixture selector asserts it too, visibly; what the brand
 * stops is the *silent* wiring in a component.
 */
export type BoardSessionPnl = ((deploymentId: string) => PnLBreakdown | null) & {
  readonly [BOARD_SESSION_PNL]: true;
};

/** A book's switch and its cells' arming, as the board reads them. */
export interface BoardBook {
  id: string;
  enabled: boolean;
  /** Every cell of the account's book as `listBooksWithPlaybooks` answers it
   *  — armed when its book carries it and the account has it on — disarmed
   *  ones included. Absent means unread, and an unread cell hides no row. See
   *  {@link BoardLeg.dormant}. */
  playbooks?: readonly BoardBookCell[];
}

/** One `(ticker, playbook)` cell. `BookPlaybook` satisfies this. */
export interface BoardBookCell {
  ticker: string;
  strategyKey: string;
  armed: boolean;
}

export interface BoardInput {
  /** The deployment cache verbatim, trash included — the filtering is this
   *  module's job so no caller repeats it. */
  deployments: readonly Deployment[];
  /** Live groups only, as `GET /api/groups` returns them — `listGroups()`
   *  excludes soft-deleted rows. A deleted group arriving here would adopt
   *  its legs onto a card the operator has already thrown away, and lend it
   *  the deleted row's name and config. */
  groups: readonly DeploymentGroup[];
  accounts: readonly BoardAccount[];
  trades: readonly BoardTrade[];
  /**
   * Whether `trades` is a snapshot that actually arrived. The trade rows are
   * the only position signal at rest — the live reading's `hasOpenPosition`
   * is itself derived from them — so `[]` before the first answer, or after a
   * read that failed, would read as *nothing open*. **Nothing is dormant until
   * this is `true`**; absent means unread.
   */
  tradesRead?: boolean;
  strategy: (key: string) => BoardStrategy | null;
  /**
   * `useLivePnL(null, "session").deployment`, wrapped to answer **`null`
   * where that selector has no reading** rather than the zero it returns.
   *
   * It answers for visible accounts only: it is built over
   * `trading.visibleAccounts` and hands back an *empty breakdown* for any
   * deployment outside that set. Two rows the board keeps are outside it by
   * construction — a **detached** leg, whose account is gone from the
   * catalogue by definition, and, with the practice-only toggle on, every
   * non-`PRAC-` card.
   *
   * Keeping those rows is the deliberate half (Detached stops being a tab);
   * passing on a zero the type cannot tell from a reading is not. A
   * plausible `$0.00` on the field that says how much you are up or down is
   * a specific claim the surface cannot stand behind — the nullability makes
   * the em-dash unavoidable rather than
   * advisable. Filtering is still *not* handled here; a caller that wants
   * only visible rows narrows `deployments`.
   *
   * **Branded** — see {@link BoardSessionPnl}. The nullability made the
   * em-dash unavoidable once something answered null; the brand is what
   * makes something answer null.
   */
  sessionPnl: BoardSessionPnl;
  /**
   * Today's regime reading for a ticker, or `null` when nothing has labelled
   * this session day — see {@link BoardRegime}. Passed in for the same reason
   * `sessionPnl` is: the fetch belongs to `useBoardModel`, and the decision
   * about what the chip may claim belongs to a pure function with a test.
   */
  regime: (ticker: TickerSymbol) => BoardRegime | null;
  /**
   * Whether a row a book materialised groups by its **book** rather than by
   * its parent row. Off by default, and the default is what keeps this change
   * scoped to the surface it was specified for.
   *
   * **Three surfaces consume this adapter and only one of them is a board.**
   * `/deployments/[id]` resolves a leg id *up* to the card that holds it and
   * scopes its trades to the legs of that card — so a book card, which holds
   * two playbooks on one account, would answer *what has this playbook done
   * here* with two playbooks' trades under one header. The editor resolves a
   * parent row id against `card.id`, which a book card is not. Both ask for
   * one card per deployment, which is what `false` answers; the Dashboard
   * asks for books.
   *
   * A `book_id` that is null is grouped the same way under either value.
   */
  groupByBook?: boolean;
  /**
   * Each book's own switch, as `GET /api/groups` answers it beside the parent
   * rows — the `books` table's `enabled`, and the only input that can say a
   * book is *off*. See {@link BoardDeployment.dormant}.
   *
   * **Optional, and absent means unread.** A book the list does not name is
   * not treated as off: the drill-in and the editor pass none, and a read that
   * has not landed must not take a card off the board.
   */
  books?: readonly BoardBook[];
  /**
   * What one entry on an account may lose today — see {@link BoardLegRisk}.
   * `boardRisk` in [board-view.ts](./board-view.ts) is the producer, for the
   * reason `sessionPnl` and `regime` have one: the fetch and the clock belong
   * to `useBoardModel`, and every arm of this answer is a sentence that
   * renders and lies if written inside JSX.
   *
   * **Keyed by account, never by deployment**, which is the whole shape of the
   * field. The budget is the account's and it is what *one* entry may lose;
   * two legs on one account are two rows reading one number, not two budgets.
   */
  risk: (accountId: number) => BoardLegRisk;
  /**
   * The account's balance and its account-state stamp — see
   * {@link BoardAccountStatus}. `boardAccountStatus` in
   * [board-view.ts](./board-view.ts) is the producer, for `risk`'s reason.
   * Keyed by account, like `risk`.
   *
   * **Optional, and absent means not shown**: only the Dashboard reads the
   * account-status route; the drill-in and the editor pass none.
   */
  accountStatus?: (accountId: number) => BoardAccountStatus;
  /**
   * The engine's setup reading for a leg — the playbook's one-sentence note
   * while its setup is formed and waiting on the trigger, else `null`. It is
   * what turns a `flat` chip into `armed-setup` and nothing else; see
   * `deriveDeploymentStatus`.
   *
   * **Optional, and absent means unread**: `useBoardModel` passes none while
   * the live stream is down — a reading that cannot be refreshed is not shown
   * as current.
   */
  setup?: (deploymentId: string) => string | null;
}

/**
 * What a leg row says about money at risk.
 *
 * **It is per account and it is per entry, and both halves are why it took a
 * wire field rather than a formatter.** The old `×N` cell died with
 * `resolveDeploymentSize` because a contract count is answered at the signal;
 * what the operator lost with it was *how much is at risk* from the home
 * screen, and the honest replacement is the account's own per-trade budget —
 * which no deployment row carried, because it is not a property of a
 * deployment.
 *
 * **Six arms, because the operator's next move differs in all six.** A
 * budget is a number to read. A `blocked` row takes no entries and needs
 * fixing — either the form has no posture on it (`--warning`) or the rule
 * model cannot price the row at all (`--danger`, the resolver's own
 * sentence). `pending` is the first read still out and renders `…`;
 * `unreadable` is a read that will not answer and renders `—`. Those two
 * are [copy.md](../../docs/modules/ui/copy.md)'s empty-slot rule, and the
 * `pending` arm is only honest because the hook ends its first wait on a
 * **settled** fetch rather than a successful one — a surface that can never
 * stop loading has spent the glyph that says a number is unavailable.
 *
 * **`silent` is the sixth and it is a gate rather than a reading**: the
 * live-account block refuses this leg, so the engine will take no entry on it
 * at any budget and the question *what would one entry risk here* does not
 * arise. It renders nothing at all — not an em-dash, which implies a value
 * that failed to resolve, and not a second `no auto-trade` stamp beside the
 * one the row's own chip is already carrying. That is the same call the `×N`
 * cell's removal made: the honest render of an unanswerable question is
 * silence, with the reason living where the row already states it.
 *
 * **`amount` is preformatted, and deliberately not through `formatUsd`.**
 * That one is a signed P&L formatter and would print `+$500.00` over a limit;
 * this carries `usd()` from the sizer's own module, the same function the
 * Risk block's line uses.
 */
export type BoardLegRisk =
  | { kind: "pending" }
  | { kind: "silent" }
  | { kind: "unreadable"; detail: string }
  | {
      kind: "budget";
      /** `$500` — unsigned, `usd()`'s convention. */
      amount: string;
      /** The phase in a word, or `null` when no phase is set and the number is
       *  simply the one the operator typed. */
      note: string | null;
      tone: "muted" | "warning";
      detail: string;
    }
  | { kind: "blocked"; note: string; tone: "warning" | "danger"; detail: string };

/**
 * What a book card's header says about its account beyond the budget: the
 * broker's balance as the account check last read it, and the account-state
 * gate's stamp when the account cannot take a deploy.
 *
 * **The balance is never a plausible zero.** `pending` is the first read still
 * out (`…`); `unknown` is a read that settled with nothing (`—`, its sentence
 * in `detail`). An `amount` is preformatted and its `detail` names when it was
 * read, so a check that stopped answering shows as an old time rather than as
 * a current figure.
 *
 * **The stamp is the server's verdict, not this surface's.** `text` is the
 * gate's own `*_STAMP` string and `detail` its reason, from `readAccountGates`.
 */
export interface BoardAccountStatus {
  balance:
    | { kind: "pending" }
    | { kind: "unknown"; detail: string }
    | { kind: "amount"; amount: string; detail: string };
  stamp: { text: string; detail: string } | null;
}

/**
 * The regime chip's two strings, from `boardRegime` in
 * [board-view.ts](./board-view.ts).
 *
 * **It states a reading and never an intent.** Nothing is gated on the label
 * in this phase, so a chip that said *standing down* would be describing a
 * rule the engine does not enforce; `detail` carries that sentence so the
 * chip cannot be read as an arming state.
 */
export interface BoardRegime {
  /** `active.compressed`, or `unknown` when the classifier failed closed. */
  label: string;
  /** The tooltip: the features behind the label and what it does not mean. */
  detail: string;
}

/**
 * Which lifecycle surface a card's ⏸/✕ address, and where `editHref`
 * points. Computed here rather than branched on in a component, so no card
 * has to reach past this adapter to a raw row.
 *
 * **`"group"` for every intact deployment.** `"deployment"` survives for
 * exactly one case — a leg whose parent row is gone — because that leg is
 * still live and `/api/deployments/[id]` is the only pair of routes that
 * can pause or delete it. It is not the standalone shape wearing a new
 * name; nothing can create one.
 *
 * **`"book"` addresses no lifecycle route at all**, which is the honest
 * answer for a card that is a book: the reconciler writes a derived row's
 * `enabled` and its `status`, the book grid's toggle is the control, and both
 * `⏸` and the `✕` are inert. It is a third value rather than a borrowed
 * `"group"` carrying a book id, because that id names no row
 * `/api/groups/[id]` could act on — a control that reached it would 404 on
 * the one card where nothing was meant to be pressed.
 */
export interface BoardTarget {
  kind: "group" | "deployment" | "book";
  id: string;
}

/**
 * What the ✎ says when `editHref` is null — one sentence, both surfaces
 * that render the control, for the reason every refusal in this app has one
 * constant ([ui/copy.md](../../docs/modules/ui/copy.md)).
 *
 * It states the rule rather than the mechanism, and it names what the
 * operator *can* still do: this row's pause and delete both work.
 */
export const BROKEN_ROW_EDIT_REASON =
  "This account's deployment settings are gone, so there is nothing to edit. Pause or delete this row.";

/**
 * What the `✎` says on a **book card**, where `editHref` is null for a reason
 * that is not the broken row's.
 *
 * **A book card is not a deployment, so a card-level edit link has no
 * subject.** Its identity is an account and each of its rows
 * is a playbook with its own configuration — one `✎` over N of them would be
 * one row's settings printed over a header that spans all of them, which is
 * the claim `deploymentIdentity` answers `null` rather than make. The control
 * stays visible and inert rather than hidden, the way the broken row's does,
 * and it names what the operator can still do: every playbook's own page is
 * one press away on its row.
 *
 * It is **not** `BOOK_DERIVED_ROW_REFUSAL`. That sentence is a route's 409
 * about a lifecycle write; nothing here is refused, and a derived row's
 * configuration is still the operator's to edit from its own page.
 */
export const BOOK_CARD_EDIT_REASON =
  "This card is a book — an account, not one deployment's settings. Each playbook is configured on its own page; open the playbook row to get there.";

/**
 * The body two server contracts already take, carried on the leg so no
 * component reassembles it from a raw row.
 *
 * `POST /api/deployments/manual-position-preflight` and
 * `confirmActivationUnderD2` both want `{ accountId, ticker, strategyKey,
 * paramValues }` — deliberately not a deployment id, so one route serves a
 * resume and a not-yet-created deployment ([deployments.md](../../docs/modules/trading/deployments.md)).
 * The board needs both: a leg's ▶ owes the activation prompts, and the unmanaged
 * strip is specified to read `previewClaim` rather than diff broker
 * positions against deployments.
 *
 * **`paramValues` is the parent's, reached through the leg**, which is what
 * every wired activation affordance already passes — restated here rather
 * than improved on, so the board asks the same question they do. It was
 * the leg's own blob until params moved to the parent, and no caller
 * changed: a leg reads its parent's params at query time.
 *
 * **It `extends ActivationTarget` rather than aligning with it by
 * coincidence.** Both consumers take that interface, and the fields matched
 * only because they were written from it; a field added or renamed there
 * would have left this a structurally-compatible-by-luck duplicate until
 * something failed at a call site. The extension costs nothing at runtime
 * (the import is type-only, so no client module is pulled in) and narrows
 * `paramValues` from the base's `Record<string, unknown>` to the schema's
 * `ParamValues`, which is what the leg actually holds.
 */
export interface BoardClaim extends ActivationTarget {
  paramValues: ParamValues;
}

export interface BoardLeg {
  /** The `deployments` row id — what `forceFlatDeployment` takes, and what
   *  a per-leg trade query is keyed by. */
  id: string;
  accountId: number;
  /**
   * The catalogue's name, or `Account <id>` when the catalogue has no row
   * for it — which is the ordinary state of a detached leg.
   *
   * **Unused on a book card's row**, where the card spans one account and its
   * header is the surface that names it; the row names the playbook instead.
   * It stays on the leg because the leg still has one, and because a card that
   * is *not* a book is a deployment fanned across accounts, where this is the
   * row's whole identity.
   */
  accountName: string;
  /** The playbook this row runs — the parent's `strategyKey`. Identical
   *  across a hand-made card's legs (they share a parent); the discriminator
   *  between a book card's rows. */
  playbookKey: string;
  /** The playbook's display name, or its key when the module is unregistered.
   *  What a book card's row renders where a leg row renders the account. */
  playbookName: string;
  /** The row's contract as the operator says it — `MNQ`, off the leg's
   *  `/MNQ`. A book spans contracts, so its rows each name theirs. */
  contract: string;
  status: DeploymentStatus;
  chip: DeploymentStatusChip;
  /** Whether the engine will take an entry on this leg. Mirrors the
   *  engine's own entry gate, so a leg reading `Active` inside a disabled
   *  group is not armed. **It is not the per-leg ⏸ direction** — that is
   *  `status === "Active"`, already on this object, because a leg's own ⏸
   *  is `PATCH /api/deployments/[id] { status }` and a leg inside a
   *  disabled group still has its own switch to flip. */
  armed: boolean;
  /**
   * Whether the live-account block refuses this leg — the server's verdict
   * on the account's row (`BoardAccount.autoTrade`), which the status ladder
   * reads too.
   *
   * **A separate field rather than a narrowing of `armed`, and rather than
   * `chip.kind === "no-auto-trade"`.** `armed` mirrors `isLegEngineEnabled`
   * and is the header rail's input, where a refused card is `armed: true` on
   * purpose so the loudest failure on the board is not also the dimmest
   * thing on it. And the chip is a *ladder*: `detached` and `paused` outrank
   * the refusal, so a detached leg — whose account is absent from the
   * catalogue, which is `UNVERIFIED` and therefore refused — reports
   * `kind: "detached"` with the refusal nowhere on the chip to be read. The
   * predicate answers directly and both of those cases come out right.
   */
  autoTradeRefused: boolean;
  /**
   * The full identity chip row for this leg — `[CD: Xs]` today, from
   * `formatDeploymentChips`, and empty when the cooldown is off. The
   * vocabulary is
   * [design-language.md](../../docs/modules/ui/design-language.md)'s
   * "Deployment identity subline"; the drill-in's header is its home.
   *
   * **Every chip is now identical across a card's legs**, since `Size` — the
   * one that could differ, off a per-leg `sizeOverride` — went with the risk
   * sizer, and the `SL` chip went with the Override / Min / Max params. It
   * stays per leg anyway rather than being hoisted onto the card: the
   * card-level question ("do the legs agree?") is answered in
   * `deployment-detail-model.ts` over these strings, and collapsing the
   * field now would delete the machinery that answers it the next time
   * something *is* per leg.
   */
  chips: string;
  detached: boolean;
  orphanReason: string | null;
  /**
   * This leg's own parent is on — `false` when the parent is gone. Per leg
   * because a book card's rows each have their own parent, so the card's
   * `switchOn` (any of them on) cannot answer for one row. It is what
   * `detachedRestoreRefusal` reads: on a book's row under a switched-off
   * parent, `clear-orphan` 409s (bugs.md A85).
   */
  parentEnabled: boolean;
  /** What a resume on this leg has to preflight, and what the unmanaged
   *  strip probes. See {@link BoardClaim}. */
  claim: BoardClaim;
  /** The leg's session money, or `null` when the selector has no reading for
   *  it — a detached leg, or any non-`PRAC-` row with practice-only on.
   *  Render an em-dash, never `$0.00`. */
  sessionPnl: PnLBreakdown | null;
  /**
   * What one entry on **this leg's account** may lose today, and what set it.
   * See {@link BoardLegRisk}.
   *
   * **It sits on the leg and not on the card, because the leg row is the only
   * place on this board that names an account.** A per-account figure on a
   * card header would be a number over N accounts that belongs to none of
   * them; on the row that carries the account name it is the account's own
   * fact, printed beside the account it is a fact about.
   *
   * **Never fold it.** Two legs on one account share one budget, and two
   * legs on two accounts do not spend theirs together — so a sum across a
   * card's legs is wrong in both directions, and the card deliberately states
   * no risk total. It is the same reason the session strip is not a fold of
   * the board.
   *
   * **A leg the live-account block refuses gets `silent`**, decided here
   * rather than in the component, because `autoTradeRefused` is on this
   * object and a gate left to JSX is a gate the next surface forgets. The
   * engine takes no entry on that account at any budget, so a figure saying
   * what one entry would risk is a claim about something that will not
   * happen — the Hard rule in
   * [design-language.md](../../docs/modules/ui/design-language.md) about
   * renders that claim the engine will act. **`armed` is deliberately not the
   * second gate here** and the doc says why: a paused leg's account still has
   * the budget its next entry will use, and this cell states a property of
   * the account rather than a promise about when.
   *
   * **`null` on a book card's row, where the figure is the card's.** That row
   * names a playbook rather than an account, and two armed playbooks on one
   * book would print one account's budget twice — the exact misreading the
   * `DL` / `DP` chips came off the identity line for. The two fields are
   * mirrored and decided together in `buildBoard`, so exactly one of
   * `BoardLeg.risk` and `BoardDeployment.risk` is populated per card and no
   * surface has to choose.
   */
  risk: BoardLegRisk | null;
  /**
   * Whether this is a book card's row of a **playbook that is off and at
   * rest** — the one row the Dashboard leaves off a card that stays
   * (2026-10-12). Built all the same; `boardVisibility` is the one reader that
   * drops it, and it counts what it drops.
   *
   * True only when both hold: (1) its book cell reads **disarmed** — the
   * account's book's armed set through {@link BoardInput.books}, `=== false`, so an
   * unread cell keeps the row — **or** the build does not register its
   * playbook; (2) it is at rest exactly as `BoardDeployment.dormant` defines
   * rest: parent disabled, leg `Paused`, no open or pending trade row, no live
   * position reading, not detached, not `pendingReconciliation`. **Never
   * inferred from the parent's switch**: a stood-down row under an armed cell is
   * armed-but-idle (bugs.md A83) and stays.
   *
   * Always `false` on a hand-made card, for a caller that did not ask for
   * books, and until {@link BoardInput.tradesRead}.
   */
  dormant: boolean;
}

export interface BoardDeployment {
  /** The parent row's id — or the **book's** id on a book card, which is the
   *  thing that card is. Nothing routes off a book card's id: its `target` is
   *  `"book"` and both lifecycle glyphs are inert. */
  id: string;
  /**
   * `name ?? strategy display name ?? strategyKey` on a hand-made card.
   *
   * **On a book card it is the book's label — the account alone** — because
   * that is what the card is, and it is assembled here rather than in the
   * header for the reason every other field is: a component that built it
   * would be reading the account off a leg to title a card, one adapter rule
   * away from reading a raw row. The account name is the catalogue's, through
   * the leg the card was opened with; every row on a book shares it.
   */
  name: string;
  /**
   * Whether `name` is the operator's own, rather than the strategy's display
   * name or the key falling through.
   *
   * The identity subline prefixes the strategy key **only when the deployment
   * carries a custom name** — otherwise the title already is the strategy and
   * the prefix repeats it. A surface cannot answer that by comparing `name`
   * against `strategyKey`, because an operator who names a deployment after
   * its strategy would lose the prefix on a string coincidence.
   */
  hasCustomName: boolean;
  /**
   * The playbook this card runs, and **empty on a book card**: a book runs as
   * many playbooks as it has armed, each named on its own row, and one key in
   * the header would be one row's identity printed over all of them. The three
   * fields under it — `timeframe`, `sessionWindow`, `intent` — are `null`,
   * `null` and `[]` there for the same reason, which are values they already
   * carry for an unregistered module.
   */
  strategyKey: string;
  /**
   * The book that materialised this deployment, or `null` for a hand-made one
   * — `deployment_groups.book_id`, carried through the adapter because a card
   * may not read a raw row for a field it draws.
   *
   * **With `groupByBook` on it is also what the card *is***: every row under
   * it is one armed playbook on one contract of one account. Three things render
   * off it — the header carries the risk cell rather than the rows, the rows
   * name playbooks rather than accounts, and the `✕` and **both** `⏸` are
   * inert with `BOOK_DERIVED_ROW_REFUSAL` ([domain.ts](../lib/trading/domain.ts)),
   * the sentence `DELETE /api/groups/[id]` and the group `PATCH`'s enable arm
   * answer 409 with. A control that 409s after a press is the *guaranteed
   * silent no-op* the `editHref` rule already names, one refusal over.
   *
   * **There is no `BOOK` stamp any more, as of 2026-09-15.** The header's
   * account name says what the card is, and a stamp beside it would be a
   * second spelling of the same fact; `GRP` keeps its own predicate on a
   * hand-made card. A card with `groupByBook` off can still carry a book id —
   * that is the drill-in's shape, and it is not a book card.
   *
   * **Always `null` on a `deployment` target.** That target is a leg whose
   * parent row is gone, and a book's pointer lives on the parent — a row with
   * no parent is not a book's row any more, whatever it was when the parent
   * existed.
   */
  bookId: string | null;
  /** The parent's ticker. **On a book card it is the first row's and names
   *  nothing** — the header prints no ticker and each row names its own
   *  contract (`BoardLeg.contract`). */
  ticker: TickerSymbol;
  /** The timeframe key, not its label — the label map is the surface's
   *  choice, exactly as it is for the status ladder. `null` when the
   *  strategy module is unknown and the params name no override, and on a
   *  book card, whose rows each have their own. */
  timeframe: string | null;
  /**
   * The **playbook's** trading window, verbatim — `HH:MM` bounds and the IANA
   * zone they are in. `null` when the strategy module is unknown, which is the
   * only way a row has no window now: the operator configures none.
   *
   * **Not `collectSessionWindows`' output.** That is main-minus-pauses and
   * can be several intervals; the card's meta line has room for the window
   * the operator set, and a surface that needs the effective intervals
   * calls the session helpers rather than reading a summary string. The
   * zone is carried rather than abbreviated for [copy.md](../../docs/modules/ui/copy.md)'s
   * reason: `ET` is a rewording, and the operator configured a zone name.
   */
  sessionWindow: MainSession | null;
  /** The instrument's regime label for the current session day, or `null`
   *  when nothing has labelled it — which is an ordinary state on a fresh
   *  install and on an instrument the archive does not cover — and on a book
   *  card whose rows span more than one contract. See {@link BoardRegime}. */
  regime: BoardRegime | null;
  /** `BoardStrategy.intent`, verbatim — guidance for the badge beside the
   *  strategy key, never a gate. Empty when the module is unknown or
   *  declares nothing. */
  intent: ReadonlyArray<StrategyIntent>;
  /**
   * What ⏸ and ✕ act on: the parent. Its pause is `PATCH /api/groups/[id]
   * {enabled}` — which snapshots and restores each leg's own state — and
   * its destroy is `DELETE /api/groups/[id]`, which gates on every leg
   * being flat. A card fanning per-leg PATCHes instead would drop the
   * snapshot semantics and desync `enabled`. The `/api/deployments/[id]`
   * pair is reached only by a leg whose parent is gone.
   *
   * **`legs.length > 1` is not this discriminator** — a deployment can hold
   * one leg — and neither is sniffing `editHref`. This field is why a card
   * never has to reach past the adapter to a raw row to find out.
   *
   * **A book card's is `"book"` and addresses nothing**; see
   * {@link BoardTarget}.
   */
  target: BoardTarget;
  /**
   * The switch position of the surface `target` names — the parent's
   * `enabled`, or the leg's `status === "Active"` when the parent is gone, or
   * **on a book card whether any of its rows is switched on**, which is what
   * an inert glyph over a book has to state: no route inverts it, and a
   * position read off the toggle's intent alone would put a greyed `▶` over a
   * book that is trading. `some` rather than `all` because a disarmed playbook
   * is a stood-down row under a book that is still on, and `▶` over a card
   * with a running row is the false half of the pair.
   * This and nothing else
   * is what ⏸/▶ renders from and what its PATCH body inverts, because
   * `PATCH /api/groups/[id]` only transitions on `enabled !== existing.enabled`
   * and a resume that is not a transition is a control that does nothing.
   *
   * It is deliberately *not* the `armed` fold below. A group whose legs are
   * every one individually paused folds to `armed: false` while
   * `group.enabled` is still true, and a ▶ built on that sends
   * `{enabled: true}` over `enabled = 1`: `enableGroupAndRestore` never
   * runs, the legs stay `Paused`, and the operator's resume silently does
   * nothing. That state is two clicks away — the per-leg ⏸ in
   * `strategy-grouped-deployments.tsx` never touches `group.enabled`.
   */
  switchOn: boolean;
  /** Whether the engine will take an entry on any leg — the fold of
   *  `BoardLeg.armed`. A chip/dimming input, never the toggle's
   *  direction. */
  armed: boolean;
  /**
   * Where the ✎ points until the deployment editor exists. Derived from
   * `target` rather than re-deciding the shape, so the two cannot disagree
   * about which surface this card belongs to.
   *
   * **`null` on a `deployment` target, and that is the honest answer rather
   * than a gap.** The editor resolves a leg id *up* to its parent, and this
   * target exists precisely when the parent is gone — so the link it used to
   * emit resolved to nothing and returned silently: no navigation, no
   * message. There is no editor for a leg alone, and there is nothing to
   * edit: the config lived on the row that went. A caller renders the
   * control inert with the reason instead of linking it.
   *
   * **`null` on a book card too, for a different reason and with a different
   * sentence** — {@link BOOK_CARD_EDIT_REASON}. `cardEditIntent` in
   * [board-view.ts](./board-view.ts) is what picks between the two, so the
   * card does not.
   */
  editHref: string | null;
  /**
   * What one entry on **this book's account** may lose today, or `null` on a
   * hand-made card, whose legs keep the cell on the row that names the
   * account. See {@link BoardLegRisk} — the six arms are that field's,
   * verbatim, from the same `boardRisk`.
   *
   * **The no-fold rule is re-read here rather than excepted.** The rule is
   * that a figure belonging to the account goes on the surface that *names*
   * the account and is never folded; a book card spans exactly one account and
   * its header is that surface, so the figure renders once and nothing is
   * summed. What the rule forbids is unchanged and is the load-bearing half:
   * **no total across cards, none on the session strip, and none on a row that
   * names a playbook.**
   *
   * **`silent` on an account the live-account block refuses**, decided here
   * off the `autoTradeRefused` the row already carries, exactly as the leg
   * cell's is — and `armed` is deliberately not the second gate, because a
   * stood-down book's account still has the budget its next entry will use.
   */
  risk: BoardLegRisk | null;
  /**
   * The book's account's balance and account-state stamp, or `null` on a
   * hand-made card and wherever `BoardInput.accountStatus` was not passed. On
   * the header for `risk`'s reason: it is the surface that names the account.
   * A hand-made card's leg rows do not carry it — their columns are fixed
   * widths with no slot for it.
   */
  account: BoardAccountStatus | null;
  legs: BoardLeg[];
  /**
   * Sum over `legs`, safe as a plain fold only while no two legs of one card
   * can claim the same broker position.
   *
   * **The creation-time gates are not what holds that.** `add-legs`,
   * `POST /api/groups` and `promote-to-group` all refuse a duplicate
   * account, but `PATCH /api/deployments/[id]` can still move a `Paused` leg
   * onto a sibling's account: its uniqueness check sits inside
   * `if (nextStatus === "Active")` and `findConflictingDeployments` is
   * `Active`-only in SQL.
   *
   * **What holds it is those two facts together.** Unrealized reaches a leg
   * only through that leg's *own* open trade row — `useLivePnL` matches
   * `(accountId, contractId)` off it — and the `Active`-only conflict check
   * stops the second leg on an account ever arming, so it never acquires
   * one. Relax that check and this fold double-counts unrealized.
   *
   * **A book card's rows are the case that argument does not cover, and a
   * second one holds them.** Two armed playbooks on one book are two rows on
   * one account and one instrument — the conflict check is what lets them
   * coexist, not what keeps them apart — so what stops both holding a position
   * on that contract at once is the engine's own gate: `hasOpenPositionOnContract`
   * blocks every other deployment on an `(account, contract)` a deployment
   * already holds. **Relax that and this fold double-counts a book's
   * unrealized**, because the two rows would map to one net broker position.
   *
   * **`null` if any leg is `null`.** A card summing the legs it can read and
   * quietly dropping the ones it cannot would report a total that is a
   * subset of itself, which is the same lie one leg's `$0.00` tells, only
   * harder to spot.
   */
  sessionPnl: PnLBreakdown | null;
  /** Legs holding a position. `null` under the same rule as `sessionPnl` —
   *  a count that silently omits the legs with no reading is wrong, not
   *  partial. */
  openPositionCount: number | null;
  /**
   * Whether this is the card of a **book that is switched off and at rest** —
   * the one card the Dashboard leaves out. The card is still built: nothing
   * deletes a derived row, and nothing here does either. `boardVisibility` in
   * [board-view.ts](./board-view.ts) is the one reader that drops it, and it
   * counts what it drops so the board can say so.
   *
   * True only when all of these hold:
   *
   *   1. it is a book card and **the book's own switch is off** — `books`'
   *      `enabled`, through {@link BoardInput.books}. Never inferred from the
   *      rows: a book that is *on* with a stood-down row is armed-but-idle, or
   *      has every playbook disarmed, and both stay on the board;
   *   2. every parent is disabled and **every leg is `Paused`** with no open or
   *      pending trade row and no live position reading. `Pausing` /
   *      `Destroying` owe a close at the broker, and an `Active` leg under an
   *      off book is holding its own slot with nothing trading it;
   *   3. no leg is detached or flagged `pendingReconciliation`.
   *
   * **A missing live reading does not keep the card.** `Paused` with no open
   * trade row is the database saying no close is owed, and those rows do not
   * go blind with the connection or the practice filter — so the card does not
   * flicker back in whenever the reading does. **The trade rows themselves
   * must have been read**, though — see {@link BoardInput.tradesRead}.
   *
   * Always `false` on a hand-made card, for a caller that did not ask for
   * books, and until the trade rows are read.
   */
  dormant: boolean;
}

export function buildBoard(input: BoardInput): BoardDeployment[] {
  const live = input.deployments.filter((d) => d.deletedAt == null);
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const groups = new Map(input.groups.map((g) => [g.id, g]));
  const openTrades = new Map<string, TradeStatus>();
  for (const t of input.trades) {
    if (t.status !== "open" && t.status !== "pending_entry" && t.status !== "pending_exit") continue;
    if (!openTrades.has(t.deploymentId)) openTrades.set(t.deploymentId, t.status);
  }

  const bookEnabled = new Map((input.books ?? []).map((b) => [b.id, b.enabled]));
  const cellArmed = new Map<string, boolean>();
  for (const book of input.books ?? []) {
    for (const cell of book.playbooks ?? []) {
      cellArmed.set(cellKey(book.id, cell.ticker, cell.strategyKey), cell.armed);
    }
  }
  // Book cards with a row that is live at the broker or needs the operator.
  const restless = new Set<string>();

  const cards = new Map<string, BoardDeployment>();
  for (const deployment of live) {
    // A leg whose parent is gone — soft-deleted out from under it, or a
    // half-finished cascade — still renders, as its own one-leg card. It is
    // a live row, and a live row missing from the board is the failure the
    // board exists to prevent. **This is the only branch that still produces
    // a `deployment` target**, and it is the broken-row path rather than a
    // second shape.
    const group = groups.get(deployment.groupId) ?? null;
    const owner = group ?? deployment;
    // Off the parent, never off the leg: the pointer is the group's column,
    // and a leg whose parent is gone reads `null` — which is the honest
    // answer, since the routes that would refuse it key on the parent too.
    const bookId = group?.bookId ?? null;
    // **The second grouping, and the only place it is decided.** A book card
    // is one account and its rows are that book's armed cells, any contract;
    // every row with no `book_id` falls through to the grouping above it,
    // unchanged. A caller that has not asked for books gets one card per
    // deployment even for a derived row — see `BoardInput.groupByBook`.
    const asBook = input.groupByBook === true && bookId != null;
    const strategy = input.strategy(owner.strategyKey);
    const leg = buildLeg(deployment, group, accounts, openTrades, input.sessionPnl, input.risk, {
      playbookKey: owner.strategyKey,
      playbookName: strategy?.name ?? owner.strategyKey,
      inBuild: strategy != null,
      // A playbook row does not name an account, so it states no budget: the
      // figure is the card header's there, and printing it on both would be
      // one account's budget rendered once per armed playbook.
      statesRisk: !asBook,
      setupNote: input.setup?.(deployment.id) ?? null,
    });

    const key = asBook ? bookId : owner.id;
    if (asBook) {
      const atRest = isAtRest(deployment, group, leg, openTrades);
      if (!atRest) restless.add(key);
      // `=== false`, so a cell the payload did not name keeps its row.
      const playbookOff =
        strategy == null ||
        cellArmed.get(cellKey(bookId, owner.ticker, owner.strategyKey)) === false;
      leg.dormant = input.tradesRead === true && atRest && playbookOff;
    }
    const card = cards.get(key);
    if (card) {
      card.legs.push(leg);
      // A book's switch has no route behind it and is inert either way; what
      // it must not do is claim `▶` over a book with a row still switched on.
      if (asBook && group != null && group.enabled) card.switchOn = true;
      continue;
    }
    const timeframe = resolveTimeframe({ timeframe: strategy?.timeframe ?? "" }, owner.paramValues);
    const target: BoardTarget = asBook
      ? { kind: "book", id: key }
      : { kind: group != null ? "group" : "deployment", id: owner.id };
    cards.set(key, {
      id: key,
      // A book is one account across contracts, so the account is its whole
      // label; each row names its own contract. A hand-made card keeps the
      // row's own name.
      name: asBook ? leg.accountName : owner.name ?? strategy?.name ?? owner.strategyKey,
      hasCustomName: !asBook && owner.name != null,
      // Empty on a book card, with `timeframe`, `sessionWindow` and `intent`
      // blank beside it: each of those is one playbook's, and this card has as
      // many playbooks as it has rows.
      strategyKey: asBook ? "" : owner.strategyKey,
      bookId,
      ticker: owner.ticker,
      timeframe: asBook || timeframe === "" ? null : timeframe,
      sessionWindow: asBook ? null : strategy?.session ?? null,
      regime: input.regime(owner.ticker),
      intent: asBook ? [] : strategy?.intent ?? [],
      target,
      switchOn: asBook
        ? group != null && group.enabled
        : group != null
          ? group.enabled
          : deployment.status === "Active",
      armed: false,
      editHref: editHref(owner.strategyKey, target),
      // The header's cell, on the one card whose header names an account. A
      // hand-made card answers `null` and its legs keep their own.
      risk: asBook ? riskCell(deployment.accountId, leg.autoTradeRefused, input.risk) : null,
      account: asBook ? accountCell(deployment.accountId, leg.autoTradeRefused, input.accountStatus) : null,
      legs: [leg],
      sessionPnl: null,
      openPositionCount: null,
      dormant: false,
    });
  }

  const board = Array.from(cards.values());
  for (const card of board) {
    card.legs.sort(byRow);
    const readings = card.legs.map((l) => l.sessionPnl);
    const known = readings.filter((p): p is PnLBreakdown => p != null);
    const complete = known.length === readings.length;
    card.sessionPnl = complete ? sumPnl(known) : null;
    card.openPositionCount = complete ? known.filter((p) => p.hasOpenPosition).length : null;
    card.armed = card.legs.some((l) => l.armed);
    // A regime label is one instrument's, so a book card spanning two has no
    // one reading to show; it keeps the chip only while its rows share one.
    if (card.target.kind === "book" && card.legs.some((l) => l.contract !== card.legs[0].contract)) {
      card.regime = null;
    }
    // `=== false`, so a book whose switch was not read stays on the board.
    card.dormant =
      input.tradesRead === true &&
      card.target.kind === "book" &&
      bookEnabled.get(card.id) === false &&
      !restless.has(card.id);
  }
  blockArmedSetups(board, openTrades);
  board.sort(byName);
  return board;
}

const HOLDING_CHIPS = new Set<DeploymentStatusChip["kind"]>(["pending-entry", "in-position", "pending-exit"]);

/**
 * An `Armed` row whose contract another row on the same account holds reads
 * `Blocked`: the engine keeps one position per (account, contract) and drops
 * the second playbook's signal (`entry_contract_locked`), so `Armed` there
 * promises an entry that cannot happen. The holder is any row with an open or
 * pending trade, across cards — a hand-made row holds the lock as well.
 */
function blockArmedSetups(board: BoardDeployment[], openTrades: Map<string, TradeStatus>): void {
  const legs = board.flatMap((c) => c.legs);
  const holders = new Map<string, BoardLeg>();
  for (const leg of legs) {
    if (openTrades.has(leg.id) || HOLDING_CHIPS.has(leg.chip.kind)) {
      holders.set(`${leg.accountId}|${leg.contract}`, leg);
    }
  }
  for (const leg of legs) {
    if (leg.chip.kind !== "armed-setup") continue;
    const holder = holders.get(`${leg.accountId}|${leg.contract}`);
    if (!holder || holder.id === leg.id) continue;
    leg.chip = {
      kind: "setup-blocked",
      tone: "muted",
      reason: [
        leg.chip.reason,
        `Blocked: ${leg.contract} on this account is held by ${holder.playbookName}, ` +
          "so this entry would be dropped until that position closes.",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
}

function buildLeg(
  deployment: Deployment,
  group: DeploymentGroup | null,
  accounts: Map<number, BoardAccount>,
  openTrades: Map<string, TradeStatus>,
  sessionPnl: (id: string) => PnLBreakdown | null,
  risk: (accountId: number) => BoardLegRisk,
  row: {
    /** The parent's strategy, which is this row's playbook. */
    playbookKey: string;
    playbookName: string;
    /** The registry answers the playbook's key. A prod build registers only
     *  the allowlist in `strategies/prod-playbooks.ts`. */
    inBuild: boolean;
    /** False on a book card's row, where the header states the budget. */
    statesRisk: boolean;
    /** `BoardInput.setup`'s answer for this leg; null when unread. */
    setupNote: string | null;
  },
): BoardLeg {
  const account = accounts.get(deployment.accountId) ?? null;
  const pnl = sessionPnl(deployment.id);
  const detached = deployment.orphanReason != null;
  // The server's verdict, read once and used for the dot's claim, the risk
  // cell's and the chip — never re-derived from the chip or the account class.
  const autoTrade = accountAutoTrade(account);
  const autoTradeRefused = !autoTrade.permitted;
  return {
    id: deployment.id,
    accountId: deployment.accountId,
    accountName: account?.name ?? `Account ${deployment.accountId}`,
    playbookKey: row.playbookKey,
    playbookName: row.playbookName,
    contract: contractLabel(deployment.ticker),
    status: deployment.status,
    chip: deriveDeploymentStatus({
      detached,
      status: deployment.status,
      autoTrade,
      openTradeStatus: openTrades.get(deployment.id) ?? null,
      // No reading is not the same as flat, and the ladder takes a boolean —
      // so a missing reading must not fall through to a positive claim of
      // flat. The rung above only branches on `pending_entry` / `pending_exit`;
      // an ordinary `open` has no rung and lands here. The durable trade row
      // is visible-account-independent, so it answers where the selector
      // cannot: with practice-only off, a PRAC leg holding contracts is
      // outside `visibleAccounts` and its P&L reads null. `detached` is
      // caught a rung higher and never reaches this line.
      // An OR, not a fallback: a reading of *no position* is not a
      // confirmation of flat while the row says one is open — a Tradovate leg
      // rendered Flat holding trade #378 that way.
      hasLivePosition: pnl?.hasOpenPosition === true || openTrades.get(deployment.id) === "open",
      playbookInBuild: row.inBuild,
      setupNote: row.setupNote,
    }),
    // The engine refuses a row with no registered module at activation, so
    // its entry gate is shut whatever the switches say.
    armed: row.inBuild && isArmed(deployment, group),
    autoTradeRefused,
    chips: identityChips(deployment.paramValues),
    detached,
    orphanReason: deployment.orphanReason,
    parentEnabled: group?.enabled ?? false,
    claim: {
      accountId: deployment.accountId,
      ticker: deployment.ticker,
      strategyKey: deployment.strategyKey,
      paramValues: deployment.paramValues,
    },
    sessionPnl: pnl,
    // Keyed by the account, not by the deployment: the budget belongs to the
    // account and every leg on it reads the same one. **`null` on a book
    // card's row**, where the row names a playbook and the header names the
    // account — the figure is the card's there, and stating it on both is one
    // budget printed once per armed playbook.
    risk: row.statesRisk ? riskCell(deployment.accountId, autoTradeRefused, risk) : null,
    dormant: false,
  };
}

/** A cell's identity — `(book, ticker, strategy_key)`, the reconciler's match. */
function cellKey(bookId: string, ticker: string, strategyKey: string): string {
  return `${bookId}\u0000${ticker}\u0000${strategyKey}`;
}

/**
 * Whether a book's row has nothing live at the broker and nothing for the
 * operator to act on — the per-row half of {@link BoardDeployment.dormant}, and
 * the rest half of {@link BoardLeg.dormant}. One predicate for both, so a row
 * and a card cannot disagree about what at rest means.
 *
 * Read off the raw row and the trade rows rather than off `chip`, because the
 * chip is a ladder: `paused` outranks `in-position`, so a paused leg holding
 * contracts has no position on its chip to be read.
 */
function isAtRest(
  deployment: Deployment,
  group: DeploymentGroup | null,
  leg: BoardLeg,
  openTrades: Map<string, TradeStatus>,
): boolean {
  if (group == null || group.enabled) return false;
  if (deployment.status !== "Paused") return false;
  if (openTrades.has(deployment.id)) return false;
  if (leg.sessionPnl?.hasOpenPosition === true) return false;
  return deployment.orphanReason == null && deployment.pendingReconciliation == null;
}

/**
 * The risk cell for one account, with the gate that is not the selector's.
 *
 * A refused row is asked nothing at all — the engine will take no entry on
 * that account at any budget, so there is no per-entry risk to state and
 * `boardRisk` is not even consulted. **One function for both cells**, because
 * a card header and a leg row answering that gate separately is the shape of
 * drift this module exists to prevent.
 */
/**
 * The header's account status, with the live-account gate applied: on an
 * account that block refuses, the balance stays and the account-state stamp
 * goes — the rows' `No Auto-Trade` chip is already the card's one refusal
 * wording, and a second stamp beside it would be two reasons for one refusal.
 */
function accountCell(
  accountId: number,
  autoTradeRefused: boolean,
  status: BoardInput["accountStatus"],
): BoardAccountStatus | null {
  const answer = status?.(accountId) ?? null;
  return answer && autoTradeRefused ? { ...answer, stamp: null } : answer;
}

function riskCell(
  accountId: number,
  autoTradeRefused: boolean,
  risk: (accountId: number) => BoardLegRisk,
): BoardLegRisk {
  return autoTradeRefused ? { kind: "silent" } : risk(accountId);
}

/**
 * The identity chip row, restated from the deleted `deployment-card.tsx`
 * including its defensive `?? 0` read.
 *
 * **It states no size, no stop rule and no daily limit, because a deployment
 * carries none of the three.** The risk sizer answers a contract count per
 * entry from the account's budget and that signal's stop; the Override / Min /
 * Max stop gates are deleted; and the daily P&L gate is the account's, spent
 * by every deployment on it. Every number this row used to print would now be
 * either invented or misattributed. See `formatDeploymentChips`.
 */
function identityChips(params: ParamValues): string {
  return formatDeploymentChips({ cooldown: Number(params.cooldownSeconds ?? 0) });
}

/**
 * Mirrors the engine's own entry gate — `isLegEngineEnabled` in
 * `engine/engine.ts`, `leg.status === "Active" && group.enabled &&
 * group.deletedAt == null`. It is restated rather than imported because the
 * engine's copy reads its in-memory `groupCache` and drags the whole server
 * graph; **change the two together.**
 *
 * The group half is what makes this worth having. A group disabled while its
 * legs still read `Active` is an ordinary state — that is exactly what
 * `enabledSnapshot` preserves — and a row rendered from `status` alone would
 * claim it is about to trade. This is the only reading that is not a lie
 * about whether the row will take an entry.
 */
function isArmed(deployment: Deployment, group: DeploymentGroup | null): boolean {
  if (deployment.status !== "Active") return false;
  if (group == null) return false;
  return group.deletedAt == null && group.enabled;
}

/**
 * Where the ✎ and the drill-in's Edit point.
 *
 * **One function, two surfaces**, which is what let the editor move without
 * either component changing: the board's ✎ and the drill-in's Edit both read
 * `card.editHref`.
 *
 * It pointed at the retired Strategies page's `editGroup` deep link until the
 * editor had a route of its own, and it was repointed only once that route
 * was driven — a deep link into a surface that exists is a working
 * affordance, one into a surface that does not is a stub.
 *
 * `strategyKey` is no longer read; it stays in the signature until the
 * editor's own retirement decides what `editHref` becomes.
 *
 * **Only a `"group"` target has an editor.** A `"deployment"` one is a leg
 * whose parent row is gone and a `"book"` one is a card holding N
 * deployments; the two answer `null` for different reasons and
 * `cardEditIntent` is what tells the operator which.
 */
function editHref(strategyKey: string, target: BoardTarget): string | null {
  void strategyKey;
  if (target.kind !== "group") return null;
  return `/deployments/${encodeURIComponent(target.id)}/edit`;
}

function sumPnl(parts: readonly PnLBreakdown[]): PnLBreakdown {
  const out = emptyPnl();
  let unrealized: number | null = 0;
  for (const p of parts) {
    out.realized += p.realized;
    // One leg with no unrealized reading leaves the card's with none (A68).
    unrealized = unrealized == null || p.unrealized == null ? null : unrealized + p.unrealized;
    out.fees += p.fees;
    out.closedCount += p.closedCount;
    out.hasOpenPosition = out.hasOpenPosition || p.hasOpenPosition;
  }
  out.unrealized = unrealized;
  out.total = unrealized == null ? null : out.realized + unrealized;
  return out;
}

function emptyPnl(): PnLBreakdown {
  return { realized: 0, unrealized: 0, fees: 0, total: 0, closedCount: 0, hasOpenPosition: false };
}

/** Codepoint order, and both comparators fall back to a stable tiebreak so
 *  the board does not reshuffle between renders. A collated sort would read
 *  better for accented operator-chosen names, and it is available
 *  deterministically — `localeCompare(b, "en")` or an `Intl.Collator("en")`
 *  pins the collation on any ICU build. What is not available is the
 *  no-argument form, which collates under the runtime default and so differs
 *  across machines. Either way it is a deliberate change with a fixture
 *  behind it and its own commit, not a passing tidy.
 *
 *  **Account first, then playbook**, which is one comparator for both kinds of
 *  row rather than a branch: a hand-made card's legs share a playbook and sort
 *  by account exactly as they did, and a book card's rows share an account and
 *  sort by the playbook that names them. The id closes it so nothing
 *  reshuffles between renders. */
/** `/MNQ` → `MNQ`: the contract as a label, the spelling the board and the
 *  book grid print beside a playbook. */
export function contractLabel(ticker: string): string {
  return ticker.replace(/^\//, "");
}

function byRow(a: BoardLeg, b: BoardLeg): number {
  if (a.accountName !== b.accountName) return a.accountName < b.accountName ? -1 : 1;
  // A book card's rows group by contract; a hand-made card's legs share one.
  if (a.contract !== b.contract) return a.contract < b.contract ? -1 : 1;
  if (a.playbookName !== b.playbookName) return a.playbookName < b.playbookName ? -1 : 1;
  if (a.accountId !== b.accountId) return a.accountId - b.accountId;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byName(a: BoardDeployment, b: BoardDeployment): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
