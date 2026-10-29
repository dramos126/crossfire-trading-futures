"use client";

import { useCallback, useEffect, useState } from "react";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { useEngineStatus } from "@/lib/hooks/use-engine-status";
import { authFailureCopy, type ConnectFailureKind } from "@/lib/hooks/use-trading/auth-answer";
import type { TradingState } from "@/lib/hooks/use-trading/types";

type TradingStatus = TradingState["status"];

interface MarketHubStatus {
  mode: "realtime" | "passive";
  autoRetry: boolean;
  lastDisconnectReason: string | null;
}

/**
 * The market-data half of the engine's seam health.
 *
 * Deliberately not the same thing as `MarketHubStatus`. The hub is one
 * socket, and a passive hub still evaluates on REST-fetched bars — so
 * `passive` is a cadence change, while `down` here means no bars are
 * reaching the engine at all and nothing is evaluating. They must not share
 * a pill.
 */
interface MarketDataHealth {
  state: "healthy" | "stale" | "down";
  reason: string | null;
}

/**
 * Why entries are refused while the feed itself is fine. Mirrors the engine's
 * `EntryHoldReason`. Not folded into `degraded`: nothing is broken, one class
 * of work is held, and the two want different tones.
 */
const ENTRY_HOLD_REASONS = ["post-outage-bar", "post-start-bar", "flap-breaker"] as const;
type EntryHoldReason = (typeof ENTRY_HOLD_REASONS)[number];

function isEntryHoldReason(value: unknown): value is EntryHoldReason {
  return ENTRY_HOLD_REASONS.some((reason) => reason === value);
}

/** The pill's detail line for each hold. Exhaustive, so a fourth reason the
 *  parser learns cannot render as some other hold's sentence. */
export const ENTRY_HOLD_DETAIL: Record<EntryHoldReason, string> = {
  "post-outage-bar": "waiting for a bar after the outage",
  "post-start-bar": "waiting for a bar after the engine started",
  "flap-breaker": "repeated crashes · restart to resume entries",
};

interface SeamHealth {
  marketData: { realtime: MarketDataHealth };
  degraded: boolean;
  frozen: string[];
  entriesHeld: EntryHoldReason | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The status body is a network boundary, so it is narrowed rather than cast.
 * Both parsers return `null` on anything unexpected and the caller keeps its
 * last good value, which is the same behaviour a missing field always had.
 */
export function parseMarketHub(value: unknown): MarketHubStatus | null {
  if (!isRecord(value)) return null;
  const mode = value.mode;
  if (mode !== "realtime" && mode !== "passive") return null;
  return {
    mode,
    autoRetry: value.autoRetry === true,
    lastDisconnectReason:
      typeof value.lastDisconnectReason === "string" ? value.lastDisconnectReason : null,
  };
}

export function parseSeamHealth(value: unknown): SeamHealth | null {
  if (!isRecord(value)) return null;
  const realtime = isRecord(value.marketData) ? value.marketData.realtime : null;
  if (!isRecord(realtime)) return null;
  const state = realtime.state;
  if (state !== "healthy" && state !== "stale" && state !== "down") return null;
  return {
    marketData: {
      realtime: { state, reason: typeof realtime.reason === "string" ? realtime.reason : null },
    },
    degraded: value.degraded === true,
    frozen: Array.isArray(value.frozen)
      ? value.frozen.filter((entry): entry is string => typeof entry === "string")
      : [],
    entriesHeld: isEntryHoldReason(value.entriesHeld) ? value.entriesHeld : null,
  };
}

export const DISCONNECTED_COPY =
  "Not connected to Topstep. Strategies will not evaluate or place orders.";

/**
 * The banner for the two connection failures. Words the failure from its
 * kind and never prints the server's text — that stays on the status rail —
 * and keeps the banner up, busy, while a retry it started is in flight.
 */
export function connectionWarning({
  status,
  errorKind,
  retrying,
  onRetry,
}: {
  status: TradingStatus;
  errorKind: ConnectFailureKind | null;
  retrying: boolean;
  onRetry: () => Promise<void>;
}): SystemWarning | null {
  const showing = status === "connecting" && retrying ? (errorKind ? "error" : "disconnected") : status;
  if (showing === "error") {
    return {
      kind: "error",
      title: "System Warning",
      message: authFailureCopy({ kind: errorKind ?? "unknown" }),
      action: "Reconnect",
      onAction: onRetry,
      busy: retrying,
    };
  }
  if (showing === "disconnected") {
    return {
      kind: "disconnected",
      title: "Disconnected",
      message: DISCONNECTED_COPY,
      action: "Connect",
      onAction: onRetry,
      busy: retrying,
    };
  }
  return null;
}

/** `muted` is a state that is deliberate rather than wrong — no broker yet. */
export type SystemTone = "ok" | "warn" | "danger" | "muted";

export const NO_BROKER_PILL = "No broker";

export interface SystemHealth {
  /** Headline status for the connection pill in the top nav. */
  pillLabel: string;
  pillTone: SystemTone;
  /** Whether the success dot should pulse. */
  pulsing: boolean;
  /** Detail string for the bottom status rail (e.g. "stream · engine hub realtime"). */
  detail: string | null;
  /** When set, the SystemWarningBar renders with this content. */
  warning: SystemWarning | null;
  /** Trigger an engine market-hub reconnect. */
  reconnectMarketHub: () => Promise<void>;
  reconnecting: boolean;
  /** Trigger a fresh REST connect (only meaningful when disconnected/error). */
  connect: () => Promise<void>;
}

export interface SystemWarning {
  kind: "disconnected" | "error" | "engine-kicked" | "market-data-down";
  title: string;
  message: string;
  /** "Reconnect" | "Connect" — what the action button should say. */
  action: string;
  onAction: () => void | Promise<void>;
  busy: boolean;
}

/**
 * Single source of truth for app-wide health: REST session, SSE stream,
 * and engine market-hub mode. Reads the engine status the stream pushes
 * (`useEngineStatus` — no poll of its own), then derives a pill (top nav), a
 * detail line (bottom rail), and an optional warning (slide-down bar) from
 * the combined state.
 */
export function useSystemHealth(): SystemHealth {
  const { status, error, errorKind, connect, token, live, noBroker } = useTrading();
  const engineStatus = useEngineStatus();
  const [marketHub, setMarketHub] = useState<MarketHubStatus | null>(null);
  const [seamHealth, setSeamHealth] = useState<SeamHealth | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // The banner's own retry, so its button can say it is working. `connect`
  // moves the status to `connecting` at once, which would take the banner
  // down mid-retry; holding it up while this is in flight is what makes the
  // busy state visible at all.
  const retryConnect = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await connect();
    } finally {
      setRetrying(false);
    }
  }, [connect, retrying]);

  // Each field keeps its last good value when a body does not parse.
  useEffect(() => {
    if (!token) {
      setMarketHub(null);
      setSeamHealth(null);
      return;
    }
    const hub = parseMarketHub(engineStatus?.marketHub);
    if (hub) setMarketHub(hub);
    const health = parseSeamHealth(engineStatus?.health);
    if (health) setSeamHealth(health);
  }, [token, engineStatus]);

  const reconnectMarketHub = useCallback(async () => {
    if (!token || reconnecting) return;
    setReconnecting(true);
    try {
      await fetch("/api/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reconnectMarketHub" }),
      });
    } finally {
      setReconnecting(false);
    }
  }, [token, reconnecting]);

  let pillLabel = "Disconnected";
  let pillTone: SystemTone = "danger";
  let pulsing = false;
  let detail: string | null = null;

  if (status === "connecting") {
    pillLabel = "Connecting…";
    pillTone = "warn";
  } else if (status === "signedOut") {
    pillLabel = "Signed Out";
    pillTone = "warn";
  } else if (status === "error") {
    pillLabel = "Error";
    pillTone = "danger";
    detail = error;
  } else if (status === "connected" && noBroker) {
    // Not red: nothing is broken, there is nothing to trade with yet, and the
    // banner under the nav says where to connect one.
    pillLabel = NO_BROKER_PILL;
    pillTone = "muted";
  } else if (status === "connected") {
    const hubRealtime = marketHub?.mode === "realtime";
    const hubPassive = marketHub?.mode === "passive";
    if (seamHealth?.degraded) {
      // Outranks every hub state below. The hub can be perfectly healthy
      // while no bars reach the engine — the bar path is REST and the hub is
      // a socket — and a green pill over a feed that stopped evaluating is
      // the exact lie this pill exists to avoid.
      pillLabel = "No Market Data";
      pillTone = "danger";
      detail = "strategies not evaluating";
    } else if (seamHealth?.entriesHeld) {
      // Warn, not danger: the feed is fine and open positions are still being
      // managed — only new entries are refused. It outranks the hub arms below
      // because those are a cadence change and this one stops trading. A green
      // "Connected" here is the same lie the degraded arm exists to avoid.
      pillLabel = "Entries Held";
      pillTone = "warn";
      detail = ENTRY_HOLD_DETAIL[seamHealth.entriesHeld];
    } else if (live && hubRealtime) {
      pillLabel = "Connected";
      pillTone = "ok";
      detail = "stream · engine hub realtime";
      pulsing = true;
    } else if (hubPassive) {
      // Hub passive must demote the pill regardless of SSE liveness — the
      // browser SSE stream and the engine's market hub use separate
      // connections, so live=true with hubPassive=true is real (engine
      // kicked while SSE keeps flowing). Keeping a green "Connected" pill
      // here masks the degraded state.
      pillLabel = "Passive";
      pillTone = "warn";
      detail = marketHub?.autoRetry
        ? "engine retrying · polling active"
        : "engine kicked · manual reconnect";
    } else if (live) {
      pillLabel = "Connected";
      pillTone = "ok";
      detail = "stream up · engine hub passive";
      pulsing = true;
    } else {
      pillLabel = "Polling";
      pillTone = "warn";
      detail = "no live stream · REST only";
    }
  }

  // Warning bar: surface the most actionable problem. Priority:
  //   1. REST auth failed (we can't talk to Topstep at all)
  //   2. REST disconnected (no token)
  //   3. Market data down — nothing is evaluating, break-even and trailing
  //      are frozen
  //   4. Engine market hub manually kicked (auto-retry suppressed)
  // Healthy / passive-with-auto-retry / polling-fallback fall through —
  // they're surfaced in the bottom status rail but don't merit a banner.
  //
  // Market data sits above the kicked-hub warning because it is strictly
  // worse: a kicked hub still evaluates on REST bars, and this is the state
  // where nothing does. It sits below the two auth failures because those
  // also stop orders, and an operator can only chase one cause at a time.
  let warning: SystemWarning | null = null;
  const connectWarning = connectionWarning({
    status,
    errorKind,
    retrying,
    onRetry: retryConnect,
  });
  if (connectWarning) {
    warning = connectWarning;
  } else if (status === "connected" && !noBroker && seamHealth?.degraded) {
    // Never with no broker, here or for the kicked hub below: an engine with
    // nothing to trade reports no feed, and that is not an outage.
    //
    // Names what has stopped, because the frozen work is invisible on the
    // broker's book: a stop that has stopped trailing looks exactly like one
    // that is still trailing. The list comes from the engine rather than
    // being written out here, so this banner and the engine log cannot drift
    // apart about what degraded mode means — which is why there is no local
    // fallback list. `degraded` is true only where the engine populated
    // `frozen`, so a fallback was a fourth copy of the list on a branch that
    // cannot run, and the copy is what drifts.
    const frozen = seamHealth.frozen.join(", ");
    warning = {
      kind: "market-data-down",
      title: "No Market Data",
      message:
        `No bars are reaching the engine, so nothing is evaluating: ${frozen} are frozen on every `
        + "deployment and on every broker — bars are one shared feed. Open positions are still "
        + "watched: the session-end flatten and the naked-position watchdog run on their own clocks "
        + "and are unaffected. Strategy exits, break-even and trailing resume on the first bar that "
        + "arrives after the feed comes back. New entries wait one bar longer, for a bar that opened "
        + "entirely after the outage.",
      action: "Reconnect Market Hub",
      onAction: reconnectMarketHub,
      busy: reconnecting,
    };
  } else if (
    status === "connected"
    && !noBroker
    && marketHub?.mode === "passive"
    && !marketHub.autoRetry
  ) {
    warning = {
      kind: "engine-kicked",
      title: "Market Hub Disconnected",
      message:
        "Engine kicked from realtime stream — likely the Topstep webapp is open. Strategies still evaluate on REST polling. Reconnect will kick whoever else is logged in.",
      action: "Reconnect Market Hub",
      onAction: reconnectMarketHub,
      busy: reconnecting,
    };
  }

  return {
    pillLabel,
    pillTone,
    pulsing,
    detail,
    warning,
    reconnectMarketHub,
    reconnecting,
    connect,
  };
}
