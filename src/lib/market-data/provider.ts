import type { BarData, RetrieveBarsRequest } from "@/lib/brokers/types";
import type { BrokerErrorKind, CredentialField } from "@/lib/brokers/plugin";

export type Unsubscribe = () => void;

export interface MarketQuote {
  contractId: string;
  price: number;
  timestamp: string;
}

/**
 * What a provider's vendor and plan can serve — not what this codebase
 * has wired up. Topstep declares all three because the gateway serves
 * all three; Databento declares only `historicalBars` because the
 * Usage-based plan has no live entitlement, and gains the other two the
 * day the account moves to Standard.
 *
 * A false capability greys out the corresponding selection in settings
 * **with the reason shown** — never a bare disabled control.
 */
export interface MarketDataCapabilities {
  /** A range in the past, from an archive or the vendor's history API. */
  readonly historicalBars: boolean;
  /** The current session, including the in-progress bar. */
  readonly liveBars: boolean;
  /** Streaming trade / top-of-book ticks. */
  readonly liveQuotes: boolean;
}

export interface MarketDataProvider {
  readonly id: string;           // "topstep" | "databento"
  readonly displayName: string;  // "Topstep" | "Databento"

  readonly capabilities: MarketDataCapabilities;

  isConfigured(): boolean;

  /**
   * Fetch historical bars. The request shape mirrors Topstep's
   * /History/retrieveBars body so the engine's existing call sites can
   * pass through unchanged. Implementations MUST return mapped `BarData`
   * (timestamp/open/high/low/close/volume) sorted ascending by
   * timestamp — Topstep itself returns newest-first; the provider is
   * the right place to normalize because it's a broker-side quirk, not
   * an engine concern.
   */
  retrieveBars(request: RetrieveBarsRequest): Promise<BarData[]>;

  // Contract resolution is deliberately absent. It is the broker
  // resolver's job — `BrokerAwareContractResolver` is per-account and
  // broker-aware, and a provider has neither. See providers.md.

  /**
   * Credential fields this provider owns, in the same shape a
   * `BrokerPlugin` declares. Empty is a legitimate answer: the Topstep
   * provider authenticates with the Topstep *broker's* credentials and
   * has none of its own, so returning them here would render the same
   * two inputs twice.
   */
  credentialSchema(): CredentialField[];

  /**
   * Prove the provider can actually reach its data, with `fields` (test
   * what the operator typed, without persisting the credential) or with
   * stored credentials when omitted. Returns provider-specific metadata
   * the caller may pass through — Databento returns its dataset range.
   * **Throws on failure**, same contract as `BrokerPlugin.testConnection`.
   *
   * A provider whose credential is optional must still treat "no
   * credential" as a failure here: the probe answers "can this key read
   * this data", and there is no key to answer for. Whether an absent
   * credential blocks Save is the Save gate's question, not this one.
   */
  testConnection(fields?: Record<string, string>): Promise<unknown>;

  /** Map a thrown error onto the shared taxonomy. `entitlement` is the
   *  one that matters here — "valid key, wrong plan" is a different
   *  operator action from "bad key". */
  classifyError(err: unknown): BrokerErrorKind;

  // Optional: subscribe to real-time quote ticks.
  // Returns an unsubscribe function. Absent on providers without a live feed.
  subscribeQuotes?(
    contractId: string,
    handler: (quote: MarketQuote) => void,
  ): Unsubscribe;
}
