import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import { TICKER_OPTIONS, type TickerSymbol } from "@/lib/trading/domain";
import type { ParamValues, PauseWindow } from "@/lib/trading/strategy-types";

const handle = engineHandle();

// D-11's activation preflight. Read-only: it answers *what would be
// force-closed under D-2 and when*, so the second of the two activation
// prompts can state the fact and the time. It places nothing.
//
// Two prompts, not one — the rule is suppressible, this is not. Which is
// also why this route exists rather than the copy being computed client-side
// from a positions list: the answer has to come from the object that
// enforces the rule, or the prompt drifts from what actually happens.
//
// `getEngineIfReady()`, never `getEngine()`. A preflight must not construct
// an engine as a side effect of asking a question, and a null engine is a
// meaningful answer the client renders rather than an error.

interface PreflightBody {
  accountId: number;
  ticker: TickerSymbol;
  strategyKey: string;
  paramValues: ParamValues;
  /** The activation prompt's live read; absent, the board strip's view read. */
  live: boolean;
}

function isHhmmPair(v: unknown): v is { start: string; end: string } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.start === "string" && typeof o.end === "string";
}

/**
 * Narrow a JSON blob to `ParamValues`, dropping anything that is not one of
 * its value shapes. A boundary, so it validates; the alternative is an `as`
 * that lets a hostile body reach `collectSessionWindows`.
 *
 * Dropping rather than rejecting is right for a *preview*: an unrecognised
 * key cannot change which session windows come out, and refusing the whole
 * body over one would leave the operator with no prompt at all. **A timezoned
 * `{start,end,timezone}` is one of the shapes now dropped** — the trading
 * window is the playbook's `config.session`, which this route resolves from
 * `strategyKey`, so a window on the wire is a claim the body is not allowed to
 * make.
 */
function toParamValues(raw: Record<string, unknown>): ParamValues {
  const out: ParamValues = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (Array.isArray(value) && value.every(isHhmmPair)) {
      out[key] = value as PauseWindow[];
    }
  }
  return out;
}

function parseBody(raw: unknown): PreflightBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  const accountId = typeof b.accountId === "number" ? b.accountId : null;
  const ticker = typeof b.ticker === "string" ? b.ticker : null;
  const strategyKey = typeof b.strategyKey === "string" ? b.strategyKey : null;
  if (accountId === null || ticker === null || strategyKey === null) return null;
  if (!TICKER_OPTIONS.some((t) => t.symbol === ticker)) return null;
  const paramValues =
    typeof b.paramValues === "object" && b.paramValues !== null && !Array.isArray(b.paramValues)
      ? toParamValues(b.paramValues as Record<string, unknown>)
      : {};
  return { accountId, ticker: ticker as TickerSymbol, strategyKey, paramValues, live: b.live === true };
}

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = parseBody(raw);
  if (!body) {
    return NextResponse.json(
      { error: "accountId, a known ticker and strategyKey are required" },
      { status: 400 },
    );
  }

  try {
    const preview = await handle.previewManualPositionClaim(body);
    if (!preview) {
      // The engine holds the contract resolver and the broker routing this
      // needs. Saying so is better than answering "nothing will be closed",
      // which is what an empty list would be read as.
      return NextResponse.json({ available: false, preview: null });
    }
    return NextResponse.json({ available: true, preview });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Preflight failed" },
      { status: 500 },
    );
  }
}
