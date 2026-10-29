/**
 * Tradovate customTag50 builder.
 *
 * Tradovate's `customTag50` field is the broker-side analog of Topstep's
 * `customTag` — a customer order tag that propagates onto fills and
 * orders so the engine can correlate broker-side state with deployment
 * intent. Documented limit is 50 characters; we cap at 45 to leave a
 * 5-char safety headroom (mirrors Topstep's 60-char cap under their
 * observed ~64-char silent-500 limit).
 *
 * Function signature mirrors `buildCustomTag` in
 * src/lib/trading/engine.ts:188 so a Phase 4 broker-aware swap is
 * mechanical (broker discriminator picks the builder).
 *
 * The shortId-extraction pattern at engine.ts:3348-3349 (orphan-bracket
 * sweep matches by `_${shortId}_` fragment) round-trips through this
 * format identically — both builders embed the first 8 chars of the
 * stripped UUID as the second segment delimited by underscores. Phase 3
 * verification step (probe-tradovate-place.mjs): confirm the
 * `customTag50` value sent on placement appears verbatim on the
 * subsequent fill event so the orphan-sweep logic survives the broker
 * swap unchanged.
 */

const TRADOVATE_CUSTOM_TAG_CAP = 45;

export function buildCustomTag(prefix: "e" | "x" | "s", deploymentId: string): string {
  const shortId = deploymentId.replace(/-/g, "").slice(0, 8);
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padStart(4, "0");
  const tag = `${prefix}_${shortId}_${ts}_${rand}`;
  if (tag.length > TRADOVATE_CUSTOM_TAG_CAP) {
    // Shouldn't be reachable with the above format (8 + 9 + 4 + 3 = 24 ish)
    // but guard anyway so a future format change can't silently overflow.
    return tag.slice(0, TRADOVATE_CUSTOM_TAG_CAP);
  }
  return tag;
}

/** Cap a pre-built tag to the 45-char safety limit. Used by the
 *  order-mapping translator when the engine has supplied a customTag of
 *  its own (the engine builds via Topstep's `buildCustomTag` today;
 *  Phase 4's broker-aware path will switch but this guard keeps the
 *  Tradovate boundary safe even if a too-long tag slips through). */
export function capCustomTag(tag: string): string {
  if (tag.length <= TRADOVATE_CUSTOM_TAG_CAP) return tag;
  return tag.slice(0, TRADOVATE_CUSTOM_TAG_CAP);
}

export const TRADOVATE_CUSTOM_TAG_MAX_LENGTH = TRADOVATE_CUSTOM_TAG_CAP;
