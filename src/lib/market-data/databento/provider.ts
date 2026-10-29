import type { BarData, RetrieveBarsRequest } from "@/lib/brokers/types";
import { TICKER_CONTRACT_MAP } from "@/lib/brokers/topstep/contract-resolver";
import type { MarketDataCapabilities, MarketDataProvider } from "@/lib/market-data/provider";
import {
  TICKER_TO_CACHE_SYMBOL,
  fetchCachedBars,
  timeframeForBarUnit,
} from "@/lib/data/cached-bars";
import {
  DatabentoProbeError,
  probeHistoricalEntitlement,
  type DatabentoProbeResult,
} from "@/lib/market-data/databento/metadata";
import { resolveDatabentoApiKey } from "@/lib/db/settings-cache";
import type { BrokerErrorKind, CredentialField } from "@/lib/brokers/plugin";
import {
  computeDatabentoCredsSignature,
  setDatabentoCredsValidatedAt,
  setDatabentoCredsValidatedSignature,
} from "@/lib/db/cred-validation";
import { setDatabentoProbeRange } from "@/lib/db/settings";

/**
 * Databento market-data provider — historical bars only, served from the
 * Parquet cache that `scripts/backfill-databento.ts` writes.
 *
 * It reads the cache rather than calling Databento's timeseries API on the
 * request path deliberately: the cache is the archive, the API is what
 * fills it, and a backtest that billed per GB on every re-run would be a
 * trap. `fetchCachedBars` splices a Topstep tail onto anything past the
 * cache's coverage, which is the normal path rather than an edge — the
 * rolling 24-hour embargo keeps the cache permanently about one session
 * behind.
 *
 * Not active anywhere yet. Selecting it is the settings work called out in
 * the proposal's open questions; registering it makes the capability model
 * and the probe real without moving any live call site onto it.
 */
class DatabentoMarketDataProvider implements MarketDataProvider {
  readonly id = "databento";
  readonly displayName = "Databento";

  // Usage-based plan: history only. `liveBars` / `liveQuotes` flip the day
  // the account moves to Standard — they are plan facts, not code facts.
  readonly capabilities: MarketDataCapabilities = {
    historicalBars: true,
    liveBars: false,
    liveQuotes: false,
  };

  /**
   * `BAR_CACHE_DIR` is the deployment seam for the reader, and the API key
   * is not: the app container mounts the cache read-only and never holds a
   * key, while the CI agent that refreshes it does. Keying "configured"
   * on the credential would report prod as unconfigured while it sits on a
   * full cache. Entitlement is what the probe answers.
   */
  isConfigured(): boolean {
    return (process.env.BAR_CACHE_DIR ?? "").length > 0;
  }

  async retrieveBars(request: RetrieveBarsRequest): Promise<BarData[]> {
    if (request.live) {
      throw new Error(
        "Databento provider cannot serve live bars — the Usage-based plan has no live " +
          "entitlement. Route the realtime path at a provider whose liveBars capability is true.",
      );
    }

    const cacheSymbol = cacheSymbolForContractId(request.contractId);
    if (!cacheSymbol) {
      throw new Error(
        `Databento provider has no cache symbol for contract ${request.contractId}. ` +
          "Add the ticker to TICKER_TO_CACHE_SYMBOL and backfill it, or fetch this " +
          "contract from Topstep.",
      );
    }

    const timeframe = timeframeForBarUnit(request.unit, request.unitNumber);
    if (!timeframe) {
      throw new Error(
        `Databento provider cannot aggregate unit=${request.unit} unitNumber=${request.unitNumber}.`,
      );
    }

    const outcome = await fetchCachedBars({
      cacheSymbol,
      timeframe,
      from: new Date(request.startTime),
      to: new Date(request.endTime),
      tailContractId: request.contractId,
    });

    if (outcome.kind === "skipped") {
      // "no-bars" is a legitimately empty range and returns empty. The other
      // two are configuration or capability failures, and returning empty
      // for them is exactly the silent short-result the proposal bans.
      if (outcome.reason === "no-bars") return [];
      if (outcome.reason === "no-coverage") {
        throw new Error(
          `Databento cache holds nothing for ${cacheSymbol}. Backfill it before selecting ` +
            "Databento as the historical source for this ticker.",
        );
      }
      throw new Error(
        `Databento cannot serve ${timeframe} bars faithfully — cache aggregation anchors to ` +
          "UTC midnight while Topstep anchors to the session, so the bar boundaries differ. " +
          "Use Topstep for timeframes of 1h and above.",
      );
    }

    // Topstep applies `limit` server-side and returns the newest N, so the
    // equivalent here is the tail of an ascending series.
    return request.limit > 0 ? outcome.bars.slice(-request.limit) : outcome.bars;
  }

  /**
   * `required: false` is the carve-out. Every broker credential is
   * mandatory; this one is not — prod holds no key and still serves bars
   * off the read-only cache. The Save gate reads "if a key is entered it
   * must validate", never "a key must be entered".
   */
  credentialSchema(): CredentialField[] {
    return [
      {
        key: "databentoApiKey",
        label: "Databento API Key",
        secret: true,
        required: false,
        envFallback: "DATABENTO_API_KEY",
      },
    ];
  }

  /**
   * Historical-entitlement probe, wired to the shared Test Connection
   * contract. Throws on failure like a plugin does; on success persists
   * the validation signature and the dataset range so Settings can show
   * coverage and staleness without re-probing on every read.
   *
   * A key supplied in `fields` is probed but never persisted — that is the
   * wizard/typed-but-unsaved flow, identical to the brokers'.
   */
  async testConnection(fields?: Record<string, string>): Promise<unknown> {
    const typed = fields?.databentoApiKey;
    const apiKey = typed && typed.length > 0 ? typed : resolveDatabentoApiKey();
    const result = await probeHistoricalEntitlement(apiKey);
    if (!result.ok) {
      throw new DatabentoProbeError(result.kind, result.message);
    }
    if (apiKey) {
      setDatabentoCredsValidatedSignature(computeDatabentoCredsSignature({ apiKey }));
      setDatabentoCredsValidatedAt(result.probedAt);
      setDatabentoProbeRange({
        dataset: result.dataset,
        start: result.range.start,
        end: result.range.end,
        probedAt: result.probedAt,
      });
    }
    return { dataset: result.dataset, range: result.range, probedAt: result.probedAt };
  }

  /**
   * `unknown` maps to `network` because `BrokerErrorKind` has no bucket
   * for "reached the vendor, could not read the answer" and the operator's
   * action — retry, then report — is the closest match. The raw body
   * travels in the message either way, which is how the real response
   * shape gets captured.
   */
  classifyError(err: unknown): BrokerErrorKind {
    if (err instanceof DatabentoProbeError) {
      return err.kind === "unknown" ? "network" : err.kind;
    }
    return "network";
  }

  /** Historical-entitlement probe against stored credentials, without the
   *  throw/persist behaviour `testConnection` layers on. */
  async probeEntitlement(): Promise<DatabentoProbeResult> {
    return probeHistoricalEntitlement(resolveDatabentoApiKey());
  }
}

/**
 * `CON.F.US.ENQ.M26` → `NQ.c.0`. The fourth id segment is Topstep's exact
 * product root, which `TICKER_CONTRACT_MAP` maps back to a ticker, which
 * the cache-symbol table maps to a vendor-canonical continuous symbol.
 */
export function cacheSymbolForContractId(contractId: string): string | null {
  const root = contractId.split(".")[3];
  if (!root) return null;
  for (const [ticker, mapping] of Object.entries(TICKER_CONTRACT_MAP)) {
    if (mapping.root !== root) continue;
    return TICKER_TO_CACHE_SYMBOL[ticker.replace(/^\//, "")] ?? null;
  }
  return null;
}

export const databentoMarketDataProvider = new DatabentoMarketDataProvider();
