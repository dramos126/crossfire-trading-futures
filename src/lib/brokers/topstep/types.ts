/**
 * Topstep-private wire shapes: the auth bodies and the
 * `{success, errorCode, errorMessage}` response envelopes every ProjectX
 * endpoint wraps its payload in. The payloads themselves are the neutral
 * broker vocabulary in `@/lib/brokers/types`.
 */
import type {
  Account,
  Contract,
  Order,
  Position,
  TradeFill,
} from "@/lib/brokers/types";

// ── Auth ──────────────────────────────────────────────────────────────

export interface AuthCredentials {
  userName: string;
  apiKey: string;
}

export interface AuthResponse {
  token: string;
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

// ── Accounts ─────────────────────────────────────────────────────────

export interface AccountSearchResponse {
  accounts: Account[];
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

// ── Positions ────────────────────────────────────────────────────────

export interface TradeSearchResponse {
  trades: TradeFill[];
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

export interface PositionSearchResponse {
  positions: Position[];
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

// ── Orders ───────────────────────────────────────────────────────────

/** An order as `/Order/searchOpen` sends it: `status` is ProjectX's wire
 *  code, not the neutral `OrderStatus` — the client maps it before any
 *  caller sees it. */
export type WireOrder = Omit<Order, "status"> & { status: number };

export interface OrderSearchResponse {
  orders: WireOrder[];
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

// ── Contracts ───────────────────────────────────────────────────────

export interface ContractSearchResponse {
  contracts: Contract[];
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

/**
 * Runtime guard for one element of `ContractSearchResponse.contracts`.
 *
 * `searchContracts` is a `Broker` member, and its callers read
 * `c.id.split(".")[3]` inside a `.filter()` — cast upstream, property
 * access downstream, which is the untrusted-response shape
 * `docs/modules/brokers/README.md` names by hand.
 *
 * **Checks only the fields a caller reads.** `description` and `symbolId`
 * are on the neutral `Contract` and have zero readers in `src/` — the only
 * mentions are prose explaining Tradovate cannot supply them. Screening on
 * them makes a vendor quirk in a field nothing touches (a `null`
 * `description` on some unrelated product) disqualify a contract the
 * caller does want, on the engine's live resolution path. Do not
 * "complete" this guard by adding them back. `executionContractId` is
 * excluded for the other reason: our own resolver stamps it and Topstep
 * never sends it.
 */
export function isContract(value: unknown): value is Contract {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.tickSize === "number" &&
    typeof o.tickValue === "number" &&
    typeof o.activeContract === "boolean"
  );
}

export interface ContractByIdResponse {
  contract: Contract;
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

// ── Historical Bars ─────────────────────────────────────────────────

export interface BarDataApi {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface RetrieveBarsResponse {
  bars: BarDataApi[];
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

// ── Market Data ──────────────────────────────────────────────────────

export interface Quote {
  contractId: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  timestamp: string;
}
