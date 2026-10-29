import { NextResponse } from "next/server";
import { hasWebAccount } from "@/lib/db/web-account";
import { resolveTradovateAppIdentity } from "@/lib/settings/tradovate-defaults";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import { ensureSetupCode } from "@/lib/auth/setup-code";

/**
 * Phase 6b — unauthenticated prefill for a first run. Only callable until
 * the web sign-in account exists. Returns ONLY non-secret fields —
 * env-resolved username + boolean flags for whether an env API key / webhook
 * is present. Webhook URL itself is never returned (sensitive), and neither
 * is the sign-in username: `hasAccount` is a boolean.
 *
 * Returns 409 once the account exists — from then on the browser signs in
 * and reads the authenticated /api/settings GET.
 *
 * Separate from /api/settings GET (which requires auth) because a first run
 * happens before the operator has a token. Keeping the surface area minimal
 * here so the unauthenticated read doesn't leak more than env source flags +
 * a username (a Topstep handle, not a secret).
 *
 * Tradovate app-identity defaults (appId/appVersion/deviceId) are also served
 * here so the optional Tradovate block ships pre-filled. deviceId
 * persist-on-generate runs the first time Settings mounts on a fresh DB; it
 * never rotates once persisted (Tradovate device-binding).
 *
 * **`brokers` carries the same schema list `/api/settings/schemas` serves.**
 * First run is a state of the Settings page now, and that page generates one
 * block per schema — registering a broker adds its block with no UI change.
 * On a fresh install there is no session to read the authenticated route
 * with, so the choice was this field or a hand-written first-run form that
 * silently stops matching the registry. It leaks nothing the rest of this
 * response does not: field *descriptors* (key, label, secret, required, and
 * `envFallback`'s env-var name where a plugin declares one — Topstep's two
 * fields do, Tradovate's seven do not), never a credential value.
 *
 * **The `configured` boolean is an oracle, and it is documented rather than
 * gated.** The same fact is one unauthenticated POST to
 * `/api/settings/test-connection` away — that route answers 409 for a
 * configured plugin and probes for an unconfigured one — so gating this field
 * would break the cold-start page it exists for and leave the oracle standing
 * on the endpoint it is actually about. The reasoning and the condition for
 * reopening it are in `docs/modules/infra/README.md`.
 */
export async function GET() {
  // **Closed once a sign-in account exists, and only then.** It used to
  // close once Topstep credentials were stored; an install that stored them
  // before sign-in existed has to reach first run to create its account, so
  // that gate would leave it with no way in. What it opens to is this body,
  // which carries no stored value — the username below is the environment's.
  // `hasAccount` is the only thing a closed answer says; never the name.
  if (hasWebAccount()) {
    return NextResponse.json({ error: "Already configured", hasAccount: true }, { status: 409 });
  }
  const plugins = brokerRegistry.allPlugins();
  // A broker with no account is an upgraded install: `settings/setup` will
  // want the printed code, so this is where it is first printed.
  const needsSetupCode = plugins.some((p) => p.isConfigured());
  if (needsSetupCode) ensureSetupCode();
  const envUsername = process.env.TOPSTEP_USERNAME ?? "";
  const envApiKey = process.env.TOPSTEP_API_KEY ?? "";
  const envWebhook = process.env.TRADE_NOTIFIER_WEBHOOK_URL ?? "";
  const identity = resolveTradovateAppIdentity();
  return NextResponse.json({
    hasAccount: false,
    needsSetupCode,
    topstepUsername: envUsername.length > 0 ? envUsername : null,
    topstepUsernameSource: envUsername.length > 0 ? "env" : "unset",
    hasApiKey: envApiKey.length > 0,
    apiKeySource: envApiKey.length > 0 ? "env" : "unset",
    hasWebhookUrl: envWebhook.length > 0,
    webhookUrlSource: envWebhook.length > 0 ? "env" : "unset",
    tradovate: {
      appId: identity.appId,
      appVersion: identity.appVersion,
      deviceId: identity.deviceId,
      appIdAuto: identity.appIdAuto,
      appVersionAuto: identity.appVersionAuto,
      deviceIdAuto: identity.deviceIdAuto,
    },
    brokers: plugins.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      isConfigured: p.isConfigured(),
      fields: p.credentialSchema(),
    })),
  });
}
