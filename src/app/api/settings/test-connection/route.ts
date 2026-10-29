import { NextRequest, NextResponse } from "next/server";
import { hasSession } from "@/lib/auth/session";
import { hasWebAccount } from "@/lib/db/web-account";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import type { BrokerErrorKind } from "@/lib/brokers/plugin";
import { TradovateAuthPenaltyError } from "@/lib/brokers/tradovate/errors";

// Wire-shape change vs. the deleted per-broker Tradovate route: `captcha`
// and `circuit_open` now pass through as the `error` field value rather
// than being collapsed to `"auth"`. Clients must treat the error union as
// the full BrokerErrorKind set.

/**
 * Generic test-connection endpoint. Replaces the per-broker `/topstep`
 * and `/tradovate` routes — dispatch goes through a registry, so adding a
 * broker plugin or a market-data provider is the only change needed to
 * wire up its Test Connection button.
 *
 * Body: `{ brokerId, fields? }` → `brokerRegistry.getPlugin`
 *       `{ providerId, fields? }` → `marketDataRegistry.getProvider`
 * Exactly one of the two keys. Both members expose the same
 * `testConnection` / `classifyError` pair, so everything below the
 * dispatch is shared.
 *
 * **`providerId` always requires a token.** The unauthenticated flow
 * described below is broker setup; a market-data provider is never
 * configured there, and the drive-by gate does not transfer — Databento's
 * `isConfigured()` keys on the cache directory, not on a credential, so
 * "unconfigured" would not mean "cold start" for it.
 *
 * Three legitimate flows, all from the Settings page:
 *   1. No fields — a valid app session required; plugin reads creds
 *      from DB.
 *   2. With fields — a valid app session required; tests what the
 *      operator typed before they Save. The session proves the
 *      operator is logged in.
 *   3. First run with no session, with fields — unauthenticated; allowed
 *      only when `plugin.isConfigured()` is false (cold-start drive-by
 *      takeover guard, mirrors setup-prefill). The middleware whitelists
 *      this path so a fresh install can test before any creds exist; the
 *      drive-by gate enforces the cold-start invariant this layer relies
 *      on.
 *
 * The session alone does NOT cover (3): that arm is unauthenticated, so
 * dropping the drive-by gate would let any caller re-test arbitrary
 * creds against an already-configured plugin. Gate stays.
 *
 * Rate-limit gap: the unauthenticated body-creds path has no per-IP
 * throttling. The drive-by gate bounds the attack window to "before
 * the operator finishes first-run setup." Within that window, a remote
 * attacker reaching the box can spam broker auth attempts (and on
 * Tradovate, trip the 1h captcha lockout). Acceptable at personal-use
 * scale.
 */

/** The wire union **is** the taxonomy — aliased rather than re-listed, so
 *  a new `BrokerErrorKind` cannot ship with the response type silently
 *  narrower than what `classifyError` can return. It used to be a
 *  hand-copied duplicate. */
type WireErrorKind = BrokerErrorKind;

interface FailResponse {
  ok: false;
  error: WireErrorKind;
  message: string;
}

/** The slice of a broker plugin / market-data provider this route needs.
 *  Both satisfy it; nothing below the dispatch cares which it got. */
interface TestableMember {
  readonly id: string;
  isConfigured(): boolean;
  testConnection(fields?: Record<string, string>): Promise<unknown>;
  classifyError(err: unknown): BrokerErrorKind;
}

interface ParsedBody {
  target: "broker" | "provider";
  id: string;
  fields?: Record<string, string>;
}

function parseBody(input: unknown): ParsedBody | { error: string } {
  if (typeof input !== "object" || input === null) {
    return { error: "Body required" };
  }
  const o = input as Record<string, unknown>;
  const hasBroker = Object.prototype.hasOwnProperty.call(o, "brokerId");
  const hasProvider = Object.prototype.hasOwnProperty.call(o, "providerId");
  if (hasBroker && hasProvider) {
    return { error: "Send brokerId or providerId, not both" };
  }
  let target: "broker" | "provider";
  let id: unknown;
  if (hasBroker) {
    target = "broker";
    id = o.brokerId;
  } else if (hasProvider) {
    target = "provider";
    id = o.providerId;
  } else {
    return { error: "brokerId or providerId required" };
  }
  if (typeof id !== "string" || id.length === 0) {
    return { error: `${target === "broker" ? "brokerId" : "providerId"} required` };
  }
  if (o.fields === undefined) {
    return { target, id };
  }
  if (typeof o.fields !== "object" || o.fields === null) {
    return { error: "fields must be an object" };
  }
  const fieldsRaw = o.fields as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fieldsRaw)) {
    if (typeof v !== "string" || v.length === 0) {
      return { error: `fields.${k} must be a non-empty string` };
    }
    if (v.length > 512) {
      return { error: `fields.${k} too long` };
    }
    fields[k] = v;
  }
  return { target, id, fields };
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const member: TestableMember | null =
    parsed.target === "broker"
      ? brokerRegistry.getPlugin(parsed.id)
      : marketDataRegistry.getProvider(parsed.id);
  if (!member) {
    return NextResponse.json(
      { error: parsed.target === "broker" ? "Unknown broker" : "Unknown provider" },
      { status: 400 },
    );
  }

  const authenticated = hasSession(request);
  const hasFields = parsed.fields !== undefined;

  if (!authenticated) {
    // Wizard flow, brokers only. Body fields are required (no DB read
    // without auth) and the plugin must be unconfigured (drive-by
    // takeover gate).
    if (parsed.target === "provider" || !hasFields) {
      return NextResponse.json({ error: "Missing session token" }, { status: 401 });
    }
    // Closed once a sign-in account exists too: from then on a first run is
    // over and the browser has a sign-in to test with.
    if (member.isConfigured() || hasWebAccount()) {
      return NextResponse.json(
        {
          ok: false,
          error: "auth",
          message: "Already configured",
        } satisfies FailResponse,
        { status: 409 },
      );
    }
  }

  try {
    const result = await member.testConnection(parsed.fields);
    const meta = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    return NextResponse.json({ ok: true, ...meta });
  } catch (err) {
    const kind = member.classifyError(err);
    return NextResponse.json(buildFailResponse(member, err, kind));
  }
}

function buildFailResponse(
  member: TestableMember,
  err: unknown,
  kind: BrokerErrorKind,
): FailResponse {
  const message = messageFor(member, err, kind);
  // Topstep historically collapsed entitlement / captcha / circuit_open
  // / rate_limited into "auth" because its classifyError doesn't emit
  // them. Tradovate distinguishes rate_limited and surfaces verbatim
  // text for captcha / circuit_open. Wire shape passes the kind through
  // unchanged; the per-broker message picker handles the divergence.
  return { ok: false, error: kind, message };
}

function messageFor(
  member: TestableMember,
  err: unknown,
  kind: BrokerErrorKind,
): string {
  if (member.id === "databento") {
    if (kind === "config_missing") {
      return "No Databento API key saved. Enter one above, or set DATABENTO_API_KEY.";
    }
    if (kind === "entitlement") {
      // Databento's own text names the plan and the dataset, which is the
      // whole reason the probe exists. Do not paraphrase it.
      return err instanceof Error ? err.message : String(err);
    }
    if (kind === "auth") {
      return "Databento rejected the API key. Check it and try again.";
    }
    if (kind === "rate_limited") {
      return "Databento rate-limited this attempt. Wait a moment, then try again.";
    }
    return err instanceof Error ? err.message : String(err);
  }
  // Topstep's market-data provider delegates to the broker plugin, so the
  // same credentials fail the same way whichever key dispatched here.
  if (member.id === "topstep") {
    switch (kind) {
      case "config_missing":
        return "Topstep credentials are incomplete — fill in username and API key, save, then test.";
      case "network":
        return "Couldn't reach Topstep — try again.";
      // Neither of these can come out of a credential probe — they are
      // order-path kinds. Given a message anyway, because the default arm
      // below blames the credentials and would send the operator to
      // re-enter a working API key.
      case "account_unavailable":
      case "order_rejected":
        return err instanceof Error ? err.message : String(err);
      default:
        return "Topstep rejected the credentials. Check your username and API key.";
    }
  }
  if (member.id === "tradovate") {
    if (kind === "config_missing") {
      return "Tradovate credentials are incomplete — fill in every field and save before testing.";
    }
    if (kind === "rate_limited") {
      const wait = err instanceof TradovateAuthPenaltyError ? err.pTimeSec : null;
      const waitText = wait !== null ? `wait ~${wait}s` : "wait a moment";
      return `Tradovate rate-limited this attempt (${waitText}). This usually means the credentials are wrong, or Test Connection has been clicked too many times in close succession. Wait, then try again — repeated penalties on the same credentials usually mean those credentials are invalid.`;
    }
    if (kind === "network") {
      return "Couldn't reach Tradovate — try again.";
    }
    // captcha / circuit_open / auth — surface the error message verbatim.
    // account_unavailable / order_rejected land here too: they cannot come
    // out of a credential probe, and Tradovate's own failureReason text is
    // the only useful thing to say if one ever does.
    return err instanceof Error ? err.message : String(err);
  }
  // Unregistered id — best-effort generic message.
  return err instanceof Error ? err.message : String(err);
}
