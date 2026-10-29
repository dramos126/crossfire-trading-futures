import {
  getBootAssertionFailureReason,
  getBootAssertionState,
} from "@/lib/trading/engine/boot/boot-assertion";
import { getStagingAllowlist } from "@/lib/trading/broker-access/staging-allowlist";
import {
  readOrdersThrough,
  readPositionsThrough,
  type AccountViewSlice,
} from "@/lib/trading/engine/realtime/account-view";
import { getBroadcaster, peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import {
  engineStatusOf,
  type AccountViewAnswer,
  type EngineHandle,
} from "@/lib/trading/engine/handle";
// Static, unlike the engine below: the pipe keeps its sinks per module graph,
// so a route graph that never loads `engine-singleton` still needs its lines
// on the `/logs` ring, in the store and escalated.
import "@/lib/trading/engine/engine-log-sinks";

function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | null = null;
  return () => (loaded ??= load());
}

// Loaded on first use, never at import: a static import here would pull the
// whole engine graph into every route that only emits on the broadcaster.
// The rest are only as heavy: the deployments table loads the strategy
// registry, and the Topstep client and its token reach the broker registry,
// which registers every plugin at import.
const engineSingleton = lazy(() => import("@/lib/trading/engine/engine-singleton"));
const deploymentsTable = lazy(() => import("@/lib/db/deployments"));
const topstepClientModule = lazy(() => import("@/lib/brokers/topstep/client"));
const browserTokenModule = lazy(() => import("@/lib/brokers/topstep/browser-token"));

async function builtEngine() {
  return (await engineSingleton()).getEngine();
}

async function peekedEngine() {
  return (await engineSingleton()).getEngineIfReady();
}

async function builtRelay() {
  return getBroadcaster((await builtEngine()).broadcasterDeps());
}

/** Thrown inside the shared live read so every waiter gets the same answer. */
class TopstepNotConfigured extends Error {}

async function answerFromView<T>(read: () => Promise<AccountViewSlice<T>>): Promise<AccountViewAnswer<T>> {
  try {
    const slice = await read();
    return { kind: "slice", items: slice.items, asOf: slice.asOf, source: slice.source };
  } catch (err) {
    if (err instanceof TopstepNotConfigured) return { kind: "topstep-not-configured" };
    throw err;
  }
}

async function topstepReadDeps() {
  const [{ TopstepClient }, { topstepBrowserToken }] = await Promise.all([
    topstepClientModule(),
    browserTokenModule(),
  ]);
  return { TopstepClient, topstepBrowserToken };
}

const LOCAL_ENGINE_HANDLE: EngineHandle = {
  ensureEngine: async () => {
    await builtEngine();
  },
  start: async (deployments) => (await builtEngine()).start(deployments),
  stop: async () => (await builtEngine()).stop(),
  sync: async (deployments) => (await builtEngine()).sync(deployments),
  isRunning: async () => (await builtEngine()).isRunning(),
  status: async () => engineStatusOf(await builtEngine()),
  reconnectMarketHub: async () => (await builtEngine()).reconnectMarketHubManually(),
  checkAccountStatuses: async () => (await builtEngine()).checkAccountStatuses(),
  refreshBrokerRegistry: async () => {
    const { partial, errors, listed } = await (await builtEngine()).refreshBrokerRegistry();
    return { partial, errors, listed };
  },
  registeredAccountIds: async (accountIds) => {
    const engine = await builtEngine();
    return accountIds.filter((id) => engine.isAccountRegistered(id));
  },
  handleOrphanedAccount: async (accountId, reason) =>
    (await builtEngine()).handleOrphanedAccount(accountId, reason),

  syncIfRunning: async () => {
    const engine = await peekedEngine();
    if (!engine) return;
    const { listManagedDeployments } = await deploymentsTable();
    engine.sync(listManagedDeployments());
  },
  stopIfRunning: async () => (await peekedEngine())?.stop(),
  nudgeClosingGuard: async () => (await peekedEngine())?.nudgeClosingGuard(),
  peekLegPosition: async (deploymentId) => {
    const state = (await peekedEngine())?.peekState(deploymentId);
    if (!state) return null;
    return { position: state.position ? { ...state.position } : null };
  },
  forceFlatDeployment: async (deploymentId) => {
    const engine = await peekedEngine();
    return engine ? engine.forceFlatDeployment(deploymentId) : null;
  },
  exitsInFlightForAccount: async (accountId) =>
    (await peekedEngine())?.exitsInFlightForAccount(accountId) ?? null,
  previewManualPositionClaim: async (input) => {
    const engine = await peekedEngine();
    return engine ? engine.previewManualPositionClaim(input) : null;
  },
  engineSessionId: async () => (await peekedEngine())?.engineSessionId ?? null,
  marketDataContractId: async (contractId) => {
    const engine = await peekedEngine();
    return engine ? engine.marketDataContractId(contractId) : null;
  },
  areHubsReady: async () => (await peekedEngine())?.areHubsReady() ?? null,
  reloadTradovateClients: async () => {
    await (await peekedEngine())?.reloadTradovateClients();
  },
  invalidateAccountNames: async () => (await peekedEngine())?.invalidateAccountNames(),

  activateFromSettings: async () => (await engineSingleton()).activateFromSettings(),
  listTopstepAccounts: async () => {
    const topstepClient = await (await engineSingleton()).getTopstepClientIfConfigured();
    return topstepClient ? await topstepClient.searchAccounts() : [];
  },
  getLogsByLevel: async (limit) => (await engineSingleton()).getLogsByLevel(limit),
  clearAllLogs: async () => (await engineSingleton()).clearAllLogs(),
  getBootAssertionState: async () => getBootAssertionState(),
  getBootAssertionFailureReason: async () => getBootAssertionFailureReason(),
  getStagingAllowlist: async () => {
    const allowed = getStagingAllowlist();
    return allowed ? [...allowed] : null;
  },

  emitDeploymentsChanged: async () => peekBroadcaster()?.emitDeploymentsChanged(),
  emitStrategyTradeClosedIfRunning: async (trades) => {
    const broadcaster = peekBroadcaster();
    if (!broadcaster) return;
    for (const t of trades) broadcaster.emitStrategyTradeClosed(t.accountId, t.deploymentId);
  },
  getConnectedState: async () => (await builtRelay())?.getConnectedState() ?? null,
  subscribeEvents: async (key, listener) => {
    const broadcaster = await builtRelay();
    if (!broadcaster) return () => {};
    broadcaster.subscribe(key, listener);
    return () => broadcaster.unsubscribe(key);
  },
  ensureRunning: async (accountIds, contractIds) => {
    await (await builtRelay())?.ensureRunning(accountIds, contractIds);
  },
  retainContractTrades: async (contractIds) => {
    await (await builtRelay())?.retainContractTrades(contractIds);
  },

  readPositions: async (numericAccountId) => {
    const { TopstepClient, topstepBrowserToken } = await topstepReadDeps();
    return answerFromView(() =>
      readPositionsThrough(
        numericAccountId,
        async () => {
          // No Topstep JWT means Topstep is not configured. Answering
          // `positions: []` here would be a wrong answer wearing a definitive
          // answer's clothes — say we cannot answer instead.
          const topstepToken = await topstepBrowserToken();
          if (!topstepToken) throw new TopstepNotConfigured();
          const client = new TopstepClient();
          client.setToken(topstepToken);
          return client.searchOpenPositions(numericAccountId);
        },
        "route",
      ),
    );
  },
  readOrders: async (numericAccountId) => {
    const { TopstepClient, topstepBrowserToken } = await topstepReadDeps();
    return answerFromView(() =>
      readOrdersThrough(
        numericAccountId,
        async () => {
          // See /api/positions: no Topstep JWT means Topstep is not configured,
          // and an empty order list would read as "this account is flat".
          const topstepToken = await topstepBrowserToken();
          if (!topstepToken) throw new TopstepNotConfigured();
          const client = new TopstepClient();
          client.setToken(topstepToken);
          return client.searchOpenOrders(numericAccountId);
        },
        "route",
      ),
    );
  },
  resolveDatedSymbols: async (contractIds) => {
    const realtime = (await engineSingleton()).getTradovateRealtimeAdapter();
    return realtime ? contractIds.map((id) => realtime.resolveDatedSymbol(id)) : null;
  },
};

/** The engine in this process, through today's singletons. Holds no state
 *  beyond the cached lazy imports. */
export function localEngineHandle(): EngineHandle {
  return LOCAL_ENGINE_HANDLE;
}
