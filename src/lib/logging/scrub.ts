/**
 * Write-time scrubbing. Every line the pipe emits passes through here
 * before it reaches stdout, the ring, or `engine_logs`.
 *
 * Privacy is a property of the *pipe*, not of the viewer: `engine_logs` is
 * the durable record and it is what gets backed up, rsynced and
 * accidentally exported, so a viewer-side redaction leaves secrets at
 * rest. The auth gate on `/logs` is no longer the privacy boundary.
 *
 * Owned by docs/modules/logging/README.md. Imports nothing — the managed
 * account set arrives through `setManagedAccountSource`, which is what
 * keeps this module (and therefore the pipe) a leaf.
 */

/** Object keys whose *value* is a secret whatever it looks like.
 *  `crossfire_session` is the sign-in cookie; `x-session-token` is the
 *  header it replaced, read for one release and listed until it is gone.
 *  Any key ending in `password` — `currentPassword`, `newPassword`,
 *  `tradovatePassword` — and first run's one-time `setupCode`. */
const SENSITIVE_KEY_RE =
  /^(authorization|cookie|set-cookie|token|apikey|api[-_]?key|[a-z_-]*password|secret|bearer|crossfire_session|x-session-token|setup[-_]?code)$/i;

/**
 * A JWT: three base64url segments, `eyJ` marking a JSON header. Matched
 * whole so the payload and signature go with the header rather than
 * surviving beside a masked first segment.
 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * A base64url-encoded JSON header at any length, for the fragment that is
 * not a whole JWT — a truncated token in an error body, a header echoed
 * without its signature. `eyJ` is a known prefix, so length is not part of
 * the test.
 */
const JWT_HEADER_RE = /\beyJ[A-Za-z0-9_-]+/g;

/**
 * `Bearer <token>`. A known prefix, so no length floor applies to the
 * *rule* — but the captured value must be long enough to be a credential
 * rather than the next English word, or `"missing Bearer auth"` scrubs to
 * `"missing Bearer [REDACTED]"`.
 */
const BEARER_TOKEN_MIN_LEN = 8;
const BEARER_RE = new RegExp(
  `\\bBearer\\s+([A-Za-z0-9._~+/=-]{${BEARER_TOKEN_MIN_LEN},})`,
  "gi",
);

/**
 * The generic opaque-token rule, and the fix for A7.
 *
 * The pattern this replaces was `\b[A-Za-z0-9_-]{40,}\b` with no further
 * test, which masked any long identifier and destroyed it permanently in
 * `engine_logs`. Two bounds are added and each one is doing work:
 *
 *   - **The run is unbroken alphanumerics.** `_` and `-` are how a
 *     structured identifier segments itself, and an opaque credential does
 *     not segment. That alone spares every dashed artifact name and
 *     composite key this app builds; the separator-bearing credentials
 *     that lose coverage as a result are base64url tokens, which the two
 *     prefix rules above catch, and structured values, which
 *     `SENSITIVE_KEY_RE` catches.
 *   - **Mixed character classes.** A credential draws on lower, upper and
 *     digit; a symbol name or a hex digest does not. `listAccounts…Trades`
 *     is 41 characters of lower and upper with no digit and survives.
 *
 * Both bounds must fail for a value to be masked, which is the direction
 * that matters: a real token has neither property.
 */
const OPAQUE_TOKEN_MIN_LEN = 40;
const OPAQUE_TOKEN_RE = new RegExp(`\\b[A-Za-z0-9]{${OPAQUE_TOKEN_MIN_LEN},}\\b`, "g");

const MASK_MIN_LEN = 12;
const MASK_HEAD_LEN = 6;
const MASK_TAIL_LEN = 4;
/** How much of a managed account number survives truncation. */
const ACCOUNT_TAIL_LEN = 4;
/** Don't blow the stack on cyclic-ish meta. */
const META_MAX_DEPTH = 4;

/**
 * Prod always redacts — `LOG_REDACT=off` is ignored there so a stray
 * `log.info("token=", state.token)` cannot leak. In dev it defaults on and
 * the opt-out exists for debugging auth flows where the raw value is the
 * thing under investigation.
 *
 * Read per call rather than latched at module load, so a test can set the
 * variable and a running process cannot be surprised by an import order.
 */
export function redactionEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return (process.env.LOG_REDACT ?? "").toLowerCase() !== "off";
}

const REDACTED = "[REDACTED]";

function maskString(s: string): string {
  if (s.length <= MASK_MIN_LEN) return REDACTED;
  return `${s.slice(0, MASK_HEAD_LEN)}…${s.slice(-MASK_TAIL_LEN)}`;
}

function hasMixedCharacterClasses(s: string): boolean {
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}

function maskTokens(s: string): string {
  return s
    .replace(BEARER_RE, (_m, token: string) => `Bearer ${maskString(token)}`)
    .replace(JWT_RE, maskString)
    .replace(JWT_HEADER_RE, maskString)
    .replace(OPAQUE_TOKEN_RE, (m) => (hasMixedCharacterClasses(m) ? maskString(m) : m));
}

// ── Managed account numbers ────────────────────────────────────────────

/**
 * Where the managed account set comes from. `db/account-brokers.ts`
 * installs this at import time — the direction has to be db → logging,
 * because `db/connection.ts` imports the logger and a static import the
 * other way closes a cycle through every table module.
 */
export type ManagedAccountSource = () => readonly number[];

let source: ManagedAccountSource | null = null;
/** `undefined` = not resolved yet; `null` = resolved to "nothing to do". */
let cachedPattern: RegExp | null | undefined;
/**
 * Reading the set opens the database, and opening the database can log.
 * One line must not be able to re-enter its own scrubber.
 */
let resolving = false;

export function setManagedAccountSource(fn: ManagedAccountSource | null): void {
  source = fn;
  cachedPattern = undefined;
}

/**
 * Drop the cached set. Called from every `account_brokers` write, so the
 * catalog the boot sequence re-seeds on each start is also what heals a
 * resolution that failed while the database was unavailable.
 */
export function refreshManagedAccounts(): void {
  cachedPattern = undefined;
}

function managedAccountPattern(): RegExp | null {
  if (cachedPattern !== undefined) return cachedPattern;
  if (!source || resolving) return null;
  resolving = true;
  try {
    const ids = Array.from(new Set(source()))
      .filter((id) => Number.isInteger(id) && String(id).length > ACCOUNT_TAIL_LEN)
      .map(String)
      .sort((a, b) => b.length - a.length);
    cachedPattern =
      ids.length === 0 ? null : new RegExp(`(?<![0-9])(?:${ids.join("|")})(?![0-9])`, "g");
  } catch {
    // The set is unavailable this instant — no truncation rather than no
    // log line. `refreshManagedAccounts` on the next catalog write retries.
    cachedPattern = null;
  } finally {
    resolving = false;
  }
  return cachedPattern;
}

/**
 * Exact-match truncation, not a digit-run heuristic. Only account numbers
 * this install actually manages are shortened, so a price, a size or an
 * order id that happens to be eight digits is left alone.
 */
function truncateAccounts(s: string): string {
  const pattern = managedAccountPattern();
  if (!pattern) return s;
  return s.replace(pattern, (m) => truncatedAccount(m));
}

/**
 * `…{last4}` — the one rendering of an account number this app produces.
 *
 * Exported because `notify/log-escalation.ts` renders the structural
 * `accountId` column into a Discord field and was building the same string
 * by hand. One truncation rule, one place, per the module doc.
 */
export function truncatedAccount(value: number | string): string {
  return `…${String(value).slice(-ACCOUNT_TAIL_LEN)}`;
}

/**
 * The ticker leg of a display name — `…4469-ema-crossover.MNQ` → `MNQ`.
 *
 * The other half of the construction `scrubDisplay` reads positionally:
 * `display` is `account-strategyKey.ticker`, strategy keys are kebab-case and
 * carry no dot, so the account is the leading digit run and the ticker is
 * what follows the last dot. Both rules live here because both are claims
 * about that one field's shape.
 *
 * It moved out of `components/log-activity.ts` on 2026-08-27 for the reason
 * `truncatedAccount` is exported: `notify/log-escalation.ts` fills the same
 * `{ticker}` slot for a Discord title and was reading the whole display into
 * it, and a component is not something `notify/` may import.
 */
export function tickerOf(display: string | null): string | null {
  if (display == null) return null;
  const dot = display.lastIndexOf(".");
  if (dot < 0 || dot === display.length - 1) return null;
  return display.slice(dot + 1);
}

// ── Entry points ───────────────────────────────────────────────────────

/** The rendered message. Tokens masked, managed account numbers truncated. */
export function scrubMessage(s: string): string {
  if (!redactionEnabled()) return s;
  return truncateAccounts(maskTokens(s));
}

/**
 * The leading account of a `display`, which is `account-strategy.ticker`.
 *
 * **This one is positional and does not consult the catalog, and that is the
 * difference that matters.** `scrubMessage`'s exact-match rule is right for
 * free text — a price, a size or an eight-digit order id must survive — but
 * it makes truncation conditional on `account_brokers` carrying the row,
 * and an account the catalog has not caught up with crossed every seam
 * whole: the durable column, the wire, both viewer lanes and a Discord
 * alert's title. `display` needs no heuristic, because its shape is a
 * construction: the run of digits before the first `-` **is** the account.
 * So it truncates on position, unconditionally, and the catalog rule stays
 * where it earns its keep.
 *
 * `scrubMessage` still runs after it, so a second managed account or a
 * token embedded in the string is handled the ordinary way, and a catalogued
 * account is already truncated by then rather than truncated twice.
 */
const DISPLAY_ACCOUNT_RE = new RegExp(`^([0-9]{${ACCOUNT_TAIL_LEN + 1},})(?=-)`);

export function scrubDisplay(display: string): string {
  if (!redactionEnabled()) return display;
  return scrubMessage(display.replace(DISPLAY_ACCOUNT_RE, (m) => truncatedAccount(m)));
}

/**
 * The Activity template's slot values, on their way to a durable column.
 *
 * Every string goes through `scrubMessage`; a number is left alone, because
 * a size, a price and a P&L are what these carry and none of them is a
 * credential. **This is a backstop, not the rule** — the rule is that a
 * value never carries an account number or a contract id in the first
 * place, and it has to be, because `display`'s positional trick is
 * unavailable here: a value's digit run is as likely to be a price as an
 * account. A managed account that reached one anyway is truncated by the
 * catalog rule, which is exactly as good as free text's.
 */
export function scrubValues(
  values: Readonly<Record<string, string | number>>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = typeof v === "string" ? scrubMessage(v) : v;
  }
  return out;
}

/**
 * Structured console detail. Sensitive keys are masked by name whatever
 * their value looks like; everything else is scrubbed as text.
 */
export function scrubMeta(value: unknown, depth = 0): unknown {
  if (!redactionEnabled()) return value;
  return scrubValue(value, depth);
}

function scrubValue(value: unknown, depth: number): unknown {
  if (depth > META_MAX_DEPTH) return value;
  if (value == null) return value;
  if (typeof value === "string") return truncateAccounts(maskTokens(value));
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = scrubValue(v, depth + 1);
    }
  }
  return out;
}
