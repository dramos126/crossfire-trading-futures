"use client";

// D-11's two activation prompts, and the reason they are two.
//
// | | shown | suppressible |
// |---|---|---|
// | 1 — the rule. Manual positions on this instrument will be closed while
// |     the deployment is in-window.                | every activation | yes, eventually |
// | 2 — the fact. You hold N right now, and it will be closed at ⟨time⟩.
// |                                    | when a position exists, or the preflight could not check | **never** |
//
// **Never let a suppressible warning carry a non-suppressible fact.** If both
// rode one checkbox, ticking it on a quiet day would silently disable the
// warning that matters on a loud one — the same shape as the live-account
// refusal, which is never suppressible either.
//
// **The "don't show again" checkbox on prompt 1 is not built yet**, and this
// module ships the split rather than the checkbox for that reason: today both
// prompts always show, which is strictly safer than one of them being
// suppressible, and the checkbox needs a real modal plus its reversal in
// Settings. What must not happen is the checkbox arriving later and being
// attached to a merged prompt, which is why the two calls are separate here
// from the first commit. See docs/modules/trading/deployments.md.
//
// **The dialog is advisory; the rule is not.** Suppressing the confirmation
// would not suppress the flatten. Declining is the meaningful choice, and
// declining means the deployment does not activate.

import type { TickerSymbol } from "@/lib/trading/domain";

export interface ManualPositionPreview {
  root: string | null;
  inWindow: boolean;
  whenNy: string | null;
  positions: { contractId: string; side: "LONG" | "SHORT"; size: number }[];
}

export interface ActivationTarget {
  accountId: number;
  ticker: TickerSymbol;
  strategyKey: string;
  paramValues: Record<string, unknown>;
}

/**
 * Prompt 1's text.
 *
 * The last paragraph is the one that has to be right. It used to promise that
 * *"outside the session window… a hand position is left alone"*, which is true
 * of this rule and false of the engine: an Active deployment keeps its
 * resolved contract in the naked-position watchdog's scope at every hour, so
 * an unstopped hand position on the exact month it trades is flattened by the
 * safety sweep whether or not the window is open. A prompt that states a
 * carve-out the engine does not honour is worse than one that states no
 * carve-out at all — this is the only place the operator is told what will and
 * will not be touched.
 */
export const D2_RULE_PROMPT =
  "Activate this deployment?\n\n" +
  "While it is Active and inside its session window, the engine closes any position on this instrument that it did not open — including one you opened by hand — and cancels that position's working orders. " +
  "This covers every contract month of the same product, not just the one the deployment trades.\n\n" +
  "While the deployment is paused, a hand position is left alone.\n\n" +
  "Outside the session window this rule does not act, with one exception: a position on the exact contract this deployment trades is closed at any hour if it has no stop-loss order covering it. " +
  "To hold one through the off-hours, give it a stop or put it on a different month.";

/**
 * Prompt 2's text. Exported so a test reads the shipped sentence rather than
 * a paraphrase of it — the *time* is the load-bearing half, and a version of
 * this that says only *that* it will happen produces the outcome D-11 names:
 * the operator activates at 08:00, sees nothing happen, concludes they are
 * fine, and is flattened ninety minutes later while not watching.
 */
export function describeHeldPositions(preview: ManualPositionPreview): string {
  const lines = preview.positions
    .map((p) => `  • ${p.contractId} — ${p.side} ${p.size}`)
    .join("\n");
  const total = preview.positions.reduce((n, p) => n + p.size, 0);
  const when = preview.inWindow
    ? "immediately, on the next sweep"
    : preview.whenNy
      ? `at ${preview.whenNy} New York time, when this deployment's session window opens`
      : "when this deployment's session window opens";
  return (
    `You hold ${total} contract${total === 1 ? "" : "s"} on this account right now that the engine did not open:\n\n` +
    `${lines}\n\n` +
    `Activating this deployment will close ${total === 1 ? "it" : "them"} ${when}, and cancel the working orders on ${total === 1 ? "it" : "them"}.\n\n` +
    "This warning cannot be turned off. Continue?"
  );
}

/**
 * Prompt 2's "could not check" form, shown when the preflight could not
 * answer. Skipping prompt 2 there told the operator the same thing an empty
 * account does — and the guard's next good read then closed a hand position
 * nobody had been told about (bugs.md A117).
 */
export const HELD_POSITIONS_UNCHECKED_PROMPT =
  "The engine could not read this account's positions just now, so it cannot say whether you hold one it would close.\n\n" +
  "If you hold a position on this instrument that the engine did not open, activating this deployment will close it, and cancel its working orders, under the rule above — once the engine can read the account.\n\n" +
  "This warning cannot be turned off. Continue?";

function isHeldPosition(v: unknown): v is ManualPositionPreview["positions"][number] {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.contractId === "string" &&
    (p.side === "LONG" || p.side === "SHORT") &&
    typeof p.size === "number"
  );
}

/**
 * Narrow the preflight response, the way the route narrows the request.
 *
 * An `as` here evaporates at runtime and the throw lands in
 * `preview.positions.length` — *outside* the `try` below — so a response that
 * did not match aborted the whole activation with a console error and no
 * prompt. Every shape that fails to parse answers the same thing a null engine
 * does: the could-not-check form of prompt 2 (A117), and proceed on the
 * operator's yes. The enforcement is server-side and unconditional, so the
 * advisory layer must never be able to block what it only describes.
 */
function toPreview(raw: unknown): ManualPositionPreview | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (body.available !== true) return null;
  const preview = body.preview;
  if (typeof preview !== "object" || preview === null) return null;

  const p = preview as Record<string, unknown>;
  const root = p.root;
  const inWindow = p.inWindow;
  const whenNy = p.whenNy;
  const positions = p.positions;
  if (root !== null && typeof root !== "string") return null;
  if (typeof inWindow !== "boolean") return null;
  if (whenNy !== null && typeof whenNy !== "string") return null;
  if (!Array.isArray(positions) || !positions.every(isHeldPosition)) return null;

  return { root, inWindow, whenNy, positions };
}

/**
 * The preflight, over the wire, narrowed.
 *
 * Exported because the board's unmanaged-positions strip asks the same
 * question the prompts do — *what would the engine force-close on this
 * account under the manual-position rule* — and must ask it through the
 * object that enforces the rule rather than by diffing broker positions
 * against deployments. A second
 * caller with its own `fetch` would be a second `toPreview` a rewording of
 * the response could silently break.
 *
 * `null` is "could not answer", never "nothing to close", and that
 * distinction is the whole reason this returns a nullable rather than an
 * empty preview.
 *
 * Without `live` the server answers from the engine's account view, which
 * costs the broker nothing and is what the strip's per-leg probes need. The
 * activation prompt passes `live`: a hand position opened since the last
 * sweep is missing from a fresh view, and prompt 2 must not miss it.
 */
export async function fetchManualPositionPreview(
  target: ActivationTarget,
  options: { live?: boolean } = {},
): Promise<ManualPositionPreview | null> {
  const res = await fetch("/api/deployments/manual-position-preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.live ? { ...target, live: true } : target),
  });
  if (!res.ok) return null;
  return toPreview(await res.json());
}

/**
 * Run both prompts. Returns false when the operator declines either.
 *
 * A preflight that cannot answer — engine not running, broker unreachable, a
 * body that does not parse — shows prompt 2's could-not-check form rather
 * than skipping it. It is still a *warning*, not a gate: the operator's yes
 * proceeds, and nothing here refuses an activation on its own, because the
 * enforcement is server-side and unconditional.
 */
export async function confirmActivationUnderD2(target: ActivationTarget): Promise<boolean> {
  if (!confirm(D2_RULE_PROMPT)) return false;

  let preview: ManualPositionPreview | null = null;
  try {
    preview = await fetchManualPositionPreview(target, { live: true });
  } catch {
    preview = null;
  }
  if (!preview) return confirm(HELD_POSITIONS_UNCHECKED_PROMPT);
  if (preview.positions.length === 0) return true;

  return confirm(describeHeldPositions(preview));
}
