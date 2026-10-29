"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { isPracticeAccount } from "@/lib/hooks/use-trading/account-selection";
import type { Account, Contract, OrderSide, OrderType } from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";

interface DevResult {
  payload?: unknown;
  response?: unknown;
  error?: string;
  status: number;
}

export default function DevPage() {
  const { token, accounts } = useTrading();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deploymentId, setDeploymentId] = useState<string>("");
  const [side, setSide] = useState<OrderSide>(0);
  const [sendNullPrices, setSendNullPrices] = useState(false);
  const [bracketTpType, setBracketTpType] = useState<OrderType>(1);
  const [bracketSlType, setBracketSlType] = useState<OrderType>(4);
  const [skipBrackets, setSkipBrackets] = useState(false);
  const [tickerOverride, setTickerOverride] = useState("");
  const [contractIdOverride, setContractIdOverride] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DevResult | null>(null);
  const [rawOrderResult, setRawOrderResult] = useState<unknown>(null);
  const [rawAccept, setRawAccept] = useState<"application/json" | "text/plain">("text/plain");
  const [bodyOverride, setBodyOverride] = useState("");

  const [searchText, setSearchText] = useState("GC");
  const [searchLive, setSearchLive] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResult, setSearchResult] = useState<Contract[] | string | null>(null);
  const [rawResult, setRawResult] = useState<unknown>(null);

  const [probeSide, setProbeSide] = useState<OrderSide>(0);
  const [probeLoading, setProbeLoading] = useState(false);
  const [probeResult, setProbeResult] = useState<unknown>(null);
  const [flattenLoading, setFlattenLoading] = useState(false);
  const [flattenResult, setFlattenResult] = useState<unknown>(null);

  const [trailProbeSide, setTrailProbeSide] = useState<OrderSide>(0);
  const [trailProbeMode, setTrailProbeMode] = useState<"bracket" | "standalone" | "promote" | "oco-test" | "modify-promote" | "standalone-v2" | "standalone-linked">("bracket");
  const [trailProbeLoading, setTrailProbeLoading] = useState(false);
  const [trailProbeResult, setTrailProbeResult] = useState<unknown>(null);

  const [deadAcctIdRaw, setDeadAcctIdRaw] = useState("");
  const [deadAcctLoading, setDeadAcctLoading] = useState(false);
  const [deadAcctResult, setDeadAcctResult] = useState<unknown>(null);

  const [clearConfirm, setClearConfirm] = useState("");
  const [clearLoading, setClearLoading] = useState(false);
  const [clearResult, setClearResult] = useState<{ ok?: boolean; deleted?: number; error?: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch("/api/deployments")
      .then((r) => r.json())
      .then((d) => {
        const list: Deployment[] = d.deployments ?? [];
        setDeployments(list);
      })
      .catch(() => {});
  }, [token]);

  // Restrict the dev tools to PRAC accounts only — these endpoints place
  // real orders, and the dev page exists to probe gateway behavior, not to
  // touch a funded account. accounts comes from useTrading, so we wait for
  // it before letting the user pick a deployment.
  const practiceAccountIds = new Set(
    accounts.filter(isPracticeAccount).map((a: Account) => a.id),
  );
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const practiceDeployments = deployments.filter((d) => practiceAccountIds.has(d.accountId));

  // Auto-select the first practice deployment once accounts + deployments load,
  // and clear a stale selection if the previously-picked deployment isn't a
  // practice one (e.g. selected before accounts loaded).
  useEffect(() => {
    if (practiceDeployments.length === 0) {
      if (deploymentId) setDeploymentId("");
      return;
    }
    if (!practiceDeployments.some((d) => d.id === deploymentId)) {
      setDeploymentId(practiceDeployments[0].id);
    }
  }, [practiceDeployments, deploymentId]);

  const deploymentLabel = (d: Deployment) => {
    const acct = accountById.get(d.accountId);
    return `${acct?.name ?? `acct ${d.accountId}`} — ${d.ticker} — ${d.strategyKey}`;
  };

  const placeTestOrder = async () => {
    if (!token) {
      setResult({ status: 401, error: "Not authenticated — connect from the sidebar first" });
      return;
    }
    if (!deploymentId) {
      setResult({ status: 400, error: "Pick a deployment" });
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/dev/place-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentId,
          side,
          sendNullPrices,
          bracketTpType,
          bracketSlType,
          skipBrackets,
          tickerOverride: tickerOverride.trim() || undefined,
          contractIdOverride: contractIdOverride.trim() || undefined,
        }),
      });
      const data = await res.json();
      setResult({ status: res.status, ...data });
    } catch (err) {
      setResult({ status: 0, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  };

  const placeRawOrder = async () => {
    if (!token) {
      setRawOrderResult({ error: "Not authenticated" });
      return;
    }

    let payload: unknown;
    const trimmedOverride = bodyOverride.trim();
    if (trimmedOverride) {
      try {
        payload = JSON.parse(trimmedOverride);
      } catch (err) {
        setRawOrderResult({
          error: `Body override is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    } else {
      const dep = deployments.find((d) => d.id === deploymentId);
      if (!dep) {
        setRawOrderResult({ error: "No deployment selected (or paste a body override)" });
        return;
      }
      const built: Record<string, unknown> = {
        accountId: dep.accountId,
        contractId: contractIdOverride.trim() || "CON.F.US.GCE.M26",
        type: 2,
        side,
        size: 1,
        limitPrice: null,
        stopPrice: null,
        trailPrice: null,
        customTag: `rawtest_${Date.now()}`,
        linkedOrderId: null,
      };
      if (!skipBrackets) {
        built.stopLossBracket = { ticks: 75, type: bracketSlType };
        built.takeProfitBracket = { ticks: 125, type: bracketTpType };
      } else {
        built.stopLossBracket = null;
        built.takeProfitBracket = null;
      }
      payload = built;
    }

    setLoading(true);
    setRawOrderResult(null);
    try {
      const res = await fetch("/api/dev/order-raw", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-accept-override": rawAccept,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      setRawOrderResult(data);
    } catch (err) {
      setRawOrderResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  };

  const runContractSearch = async () => {
    if (!token) {
      setSearchResult("Not authenticated — connect from the sidebar first");
      return;
    }
    setSearchLoading(true);
    setSearchResult(null);
    setRawResult(null);
    try {
      const res = await fetch("/api/dev/contract-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchText, live: searchLive }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSearchResult(data.error ?? `HTTP ${res.status}`);
      } else {
        setSearchResult(data.contracts as Contract[]);
      }
    } catch (err) {
      setSearchResult(err instanceof Error ? err.message : String(err));
    } finally {
      setSearchLoading(false);
    }
  };

  const runProbe = async () => {
    if (!token) {
      setProbeResult({ error: "Not authenticated — connect from the sidebar first" });
      return;
    }
    if (!deploymentId) {
      setProbeResult({ error: "Pick a deployment" });
      return;
    }
    setProbeLoading(true);
    setProbeResult(null);
    setFlattenResult(null);
    try {
      const res = await fetch("/api/dev/probe-modify-through-market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploymentId, side: probeSide }),
      });
      setProbeResult(await res.json());
    } catch (err) {
      setProbeResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setProbeLoading(false);
    }
  };

  // Probe: send a place-order request with an account id that doesn't
  // belong to us. We want to know what error shape Topstep returns so the
  // engine can detect the combine→XFA case (account vanishes mid-session)
  // and auto-pause orphan deployments. Uses the existing /api/dev/order-raw
  // passthrough so we capture status + headers + body verbatim.
  const probeDeadAccount = async () => {
    if (!token) {
      setDeadAcctResult({ error: "Not authenticated — connect from the sidebar first" });
      return;
    }
    // Random 8-digit account id that's almost certainly not ours. Always
    // round to a value bigger than any account id we've seen (~30M) so it
    // can't accidentally collide with somebody's real account.
    const generatedId = deadAcctIdRaw.trim()
      ? Number(deadAcctIdRaw.trim())
      : 90_000_000 + Math.floor(Math.random() * 9_999_999);
    if (!Number.isFinite(generatedId)) {
      setDeadAcctResult({ error: "Account id must be numeric" });
      return;
    }
    setDeadAcctLoading(true);
    setDeadAcctResult(null);
    try {
      const payload = {
        accountId: generatedId,
        contractId: "CON.F.US.MNQ.M26",
        type: 2,
        side: 0,
        size: 1,
        limitPrice: null,
        stopPrice: null,
        trailPrice: null,
        customTag: `dead_acct_probe_${Date.now()}`,
        linkedOrderId: null,
        stopLossBracket: null,
        takeProfitBracket: null,
      };
      const res = await fetch("/api/dev/order-raw", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-accept-override": "application/json",
        },
        body: JSON.stringify(payload),
      });
      setDeadAcctResult({ usedAccountId: generatedId, response: await res.json() });
    } catch (err) {
      setDeadAcctResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setDeadAcctLoading(false);
    }
  };

  const clearAllTrades = async () => {
    if (!token) return;
    if (clearConfirm !== "DELETE ALL TRADES") return;
    setClearLoading(true);
    setClearResult(null);
    try {
      const res = await fetch("/api/dev/clear-trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: clearConfirm }),
      });
      const data = await res.json();
      setClearResult(data);
      if (res.ok) setClearConfirm("");
    } catch (err) {
      setClearResult({ error: err instanceof Error ? err.message : "Request failed" });
    } finally {
      setClearLoading(false);
    }
  };

  const flattenProbe = async () => {
    if (!token || !deploymentId) return;
    setFlattenLoading(true);
    setFlattenResult(null);
    try {
      const res = await fetch("/api/dev/flatten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploymentId }),
      });
      setFlattenResult(await res.json());
    } catch (err) {
      setFlattenResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setFlattenLoading(false);
    }
  };

  // Probe: trailing-stop (OrderType=5). Two modes:
  //   bracket    — does Topstep honor stopLossBracket: { type: 5 }?
  //   standalone — units of trailPrice + does the broker tighten server-side?
  // Standalone mode takes ~60s (samples at 0/15/30/60s). See route file
  // for full sequence + interpretation rules.
  const runTrailProbe = async () => {
    if (!token) {
      setTrailProbeResult({ error: "Not authenticated — connect from the sidebar first" });
      return;
    }
    if (!deploymentId) {
      setTrailProbeResult({ error: "Pick a deployment" });
      return;
    }
    setTrailProbeLoading(true);
    setTrailProbeResult(null);
    try {
      const res = await fetch("/api/dev/probe-trailing-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploymentId, side: trailProbeSide, mode: trailProbeMode }),
      });
      setTrailProbeResult(await res.json());
    } catch (err) {
      setTrailProbeResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTrailProbeLoading(false);
    }
  };

  const runRawSearch = async () => {
    if (!token) return;
    setSearchLoading(true);
    setRawResult(null);
    try {
      const res = await fetch("/api/dev/contract-raw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchText, live: searchLive }),
      });
      const data = await res.json();
      setRawResult(data);
    } catch (err) {
      setRawResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSearchLoading(false);
    }
  };

  return (
    <AppShell>
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight mb-6">Dev Tools</h1>

          <section className="mb-8 p-4 rounded-lg border border-[var(--card-border)] bg-[var(--card)]">
            <h2 className="text-lg font-semibold mb-3">Contract search</h2>
            <p className="text-xs text-[var(--muted)] mb-4">
              Lists all contracts returned for a search string with their{" "}
              <code>activeContract</code> flag. Use to verify which contract the resolver
              picks (and whether there&apos;s a better match).
            </p>
            <div className="flex items-end gap-3 mb-4">
              <label className="text-sm flex-1">
                <span className="block text-[var(--muted)] text-xs mb-1">Search text</span>
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 font-mono"
                />
              </label>
              <label className="flex items-center gap-2 text-sm pb-1">
                <input
                  type="checkbox"
                  checked={searchLive}
                  onChange={(e) => setSearchLive(e.target.checked)}
                />
                <span>live</span>
              </label>
              <button
                onClick={runContractSearch}
                disabled={searchLoading || !searchText}
                className="px-4 py-2 rounded-md bg-[var(--accent)] text-white text-sm disabled:opacity-50"
              >
                {searchLoading ? "Searching..." : "Search"}
              </button>
              <button
                onClick={runRawSearch}
                disabled={searchLoading || !searchText}
                className="px-4 py-2 rounded-md border border-[var(--card-border)] text-sm disabled:opacity-50"
                title="Shows every field Topstep returns, including ones our typed Contract interface hides"
              >
                Raw
              </button>
            </div>
            {searchResult && (
              <div className="mt-2">
                {typeof searchResult === "string" ? (
                  <pre className="text-xs bg-[var(--bg)] border border-[var(--card-border)] rounded-md p-2 overflow-auto whitespace-pre-wrap">
                    {searchResult}
                  </pre>
                ) : (
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="text-[var(--muted)] text-left">
                        <th className="py-1 pr-2">id</th>
                        <th className="py-1 pr-2">name</th>
                        <th className="py-1 pr-2">tickSize</th>
                        <th className="py-1 pr-2">tickValue</th>
                        <th className="py-1 pr-2">active</th>
                      </tr>
                    </thead>
                    <tbody>
                      {searchResult.map((c) => (
                        <tr key={c.id} className="border-t border-[var(--card-border)]">
                          <td className="py-1 pr-2">{c.id}</td>
                          <td className="py-1 pr-2">{c.name}</td>
                          <td className="py-1 pr-2">{c.tickSize}</td>
                          <td className="py-1 pr-2">{c.tickValue}</td>
                          <td className="py-1 pr-2">{c.activeContract ? "yes" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            {rawResult != null && (
              <div className="mt-4">
                <div className="text-xs text-[var(--muted)] mb-1">Raw Topstep response</div>
                <pre className="text-xs bg-[var(--bg)] border border-[var(--card-border)] rounded-md p-2 overflow-auto">
                  {JSON.stringify(rawResult, null, 2)}
                </pre>
              </div>
            )}
          </section>

          <section className="mb-8 p-4 rounded-lg border border-[var(--card-border)] bg-[var(--card)]">
            <h2 className="text-lg font-semibold mb-3">Place test order</h2>
            <p className="text-xs text-[var(--muted)] mb-4">
              Fires <code>POST /api/Order/place</code> using a deployment&apos;s account,
              resolved contract, strategy type, and TP/SL params. Useful for probing
              payload variants against the Topstep gateway.
            </p>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <label className="text-sm">
                <span className="block text-[var(--muted)] text-xs mb-1">Deployment</span>
                <select
                  value={deploymentId}
                  onChange={(e) => setDeploymentId(e.target.value)}
                  className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 [&>option]:text-black"
                >
                  {practiceDeployments.length === 0 && (
                    <option value="">No practice deployments</option>
                  )}
                  {practiceDeployments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {deploymentLabel(d)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm">
                <span className="block text-[var(--muted)] text-xs mb-1">Side</span>
                <select
                  value={side}
                  onChange={(e) => setSide(Number(e.target.value) as OrderSide)}
                  className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 [&>option]:text-black"
                >
                  <option value={0}>BUY (0)</option>
                  <option value={1}>SELL (1)</option>
                </select>
              </label>

              <label className="text-sm">
                <span className="block text-[var(--muted)] text-xs mb-1">TP bracket type</span>
                <select
                  value={bracketTpType}
                  onChange={(e) => setBracketTpType(Number(e.target.value) as OrderType)}
                  className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 [&>option]:text-black"
                >
                  <option value={1}>1 Limit</option>
                  <option value={4}>4 Stop</option>
                </select>
              </label>

              <label className="text-sm">
                <span className="block text-[var(--muted)] text-xs mb-1">SL bracket type</span>
                <select
                  value={bracketSlType}
                  onChange={(e) => setBracketSlType(Number(e.target.value) as OrderType)}
                  className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 [&>option]:text-black"
                >
                  <option value={4}>4 Stop</option>
                  <option value={1}>1 Limit</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <label className="text-sm">
                <span className="block text-[var(--muted)] text-xs mb-1">
                  Ticker override (e.g. /ES, /MES)
                </span>
                <input
                  type="text"
                  value={tickerOverride}
                  onChange={(e) => setTickerOverride(e.target.value)}
                  placeholder="leave blank to use deployment ticker"
                  className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 font-mono"
                />
              </label>
              <label className="text-sm">
                <span className="block text-[var(--muted)] text-xs mb-1">
                  Contract id override
                </span>
                <input
                  type="text"
                  value={contractIdOverride}
                  onChange={(e) => setContractIdOverride(e.target.value)}
                  placeholder="CON.F.US.XXX.YYY"
                  className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 font-mono"
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm mb-2">
              <input
                type="checkbox"
                checked={sendNullPrices}
                onChange={(e) => setSendNullPrices(e.target.checked)}
              />
              <span>
                Send <code>limitPrice</code>/<code>stopPrice</code>/<code>trailPrice</code> as
                explicit <code>null</code> (docs sample style)
              </span>
            </label>

            <label className="flex items-center gap-2 text-sm mb-4">
              <input
                type="checkbox"
                checked={skipBrackets}
                onChange={(e) => setSkipBrackets(e.target.checked)}
              />
              <span>Skip TP/SL brackets (bare market order)</span>
            </label>

            <label className="block text-sm mb-3">
              <span className="block text-[var(--muted)] text-xs mb-1">
                Raw body override (paste JSON; leave blank to use form fields above — used only by &quot;Place raw&quot;)
              </span>
              <textarea
                value={bodyOverride}
                onChange={(e) => setBodyOverride(e.target.value)}
                spellCheck={false}
                rows={8}
                placeholder={`{\n  "accountId": 0,\n  "contractId": "CON.F.US.XXX.YYY",\n  "type": 2,\n  "side": 0,\n  "size": 1,\n  ...\n}`}
                className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 font-mono text-xs"
              />
            </label>

            <div className="flex items-center gap-3">
              <button
                onClick={placeTestOrder}
                disabled={loading || !deploymentId}
                className="px-4 py-2 rounded-md bg-[var(--accent)] text-white text-sm disabled:opacity-50"
              >
                {loading ? "Placing..." : "Place test order"}
              </button>
              <button
                onClick={placeRawOrder}
                disabled={loading || (!deploymentId && !bodyOverride.trim())}
                className="px-4 py-2 rounded-md border border-[var(--card-border)] text-sm disabled:opacity-50"
                title="Direct passthrough to /api/Order/place — shows raw response headers, status, and body"
              >
                Place raw (docs-shape)
              </button>
              <label className="text-xs flex items-center gap-2">
                <span className="text-[var(--muted)]">Accept:</span>
                <select
                  value={rawAccept}
                  onChange={(e) => setRawAccept(e.target.value as typeof rawAccept)}
                  className="bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 [&>option]:text-black"
                >
                  <option value="application/json">application/json</option>
                  <option value="text/plain">text/plain</option>
                </select>
              </label>
            </div>

            {rawOrderResult != null && (
              <div className="mt-4">
                <div className="text-xs text-[var(--muted)] mb-1">Raw order response</div>
                <pre className="text-xs bg-[var(--bg)] border border-[var(--card-border)] rounded-md p-2 overflow-auto">
                  {JSON.stringify(rawOrderResult, null, 2)}
                </pre>
              </div>
            )}

            {result && (
              <div className="mt-4 space-y-3">
                <div className="text-xs text-[var(--muted)]">
                  HTTP <span className="font-mono">{result.status}</span>
                </div>
                {result.error && (
                  <div>
                    <div className="text-xs text-[var(--muted)] mb-1">Error</div>
                    <pre className="text-xs bg-[var(--bg)] border border-[var(--card-border)] rounded-md p-2 overflow-auto whitespace-pre-wrap">
                      {result.error}
                    </pre>
                  </div>
                )}
                {result.payload != null && (
                  <div>
                    <div className="text-xs text-[var(--muted)] mb-1">Payload sent</div>
                    <pre className="text-xs bg-[var(--bg)] border border-[var(--card-border)] rounded-md p-2 overflow-auto">
                      {JSON.stringify(result.payload, null, 2)}
                    </pre>
                  </div>
                )}
                {result.response != null && (
                  <div>
                    <div className="text-xs text-[var(--muted)] mb-1">Response</div>
                    <pre className="text-xs bg-[var(--bg)] border border-[var(--card-border)] rounded-md p-2 overflow-auto">
                      {JSON.stringify(result.response, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="mb-8 p-4 rounded-lg border border-[var(--card-border)] bg-[var(--card)]">
            <h2 className="text-lg font-semibold mb-3">Probe: modify SL through market</h2>
            <p className="text-xs text-[var(--muted)] mb-4">
              Practice account only. Places a market order with a wide stop, then
              modifies the resulting SL to a price clearly through market (long: above
              bid; short: below ask). Reports whether the original SL survives. Position
              is left open — use Flatten when done inspecting.{" "}
              <a
                href="https://gateway.docs.projectx.com/docs/api-reference/order/order-modify"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                /api/Order/modify docs
              </a>
            </p>
            <div className="flex items-end gap-3 mb-4">
              <label className="text-sm flex-1">
                <span className="block text-[var(--muted)] text-xs mb-1">Deployment</span>
                <select
                  value={deploymentId}
                  onChange={(e) => setDeploymentId(e.target.value)}
                  className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 [&>option]:text-black"
                >
                  {practiceDeployments.length === 0 && (
                    <option value="">No practice deployments</option>
                  )}
                  {practiceDeployments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {deploymentLabel(d)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-[var(--muted)] text-xs mb-1">Side</span>
                <select
                  value={probeSide}
                  onChange={(e) => setProbeSide(Number(e.target.value) as OrderSide)}
                  className="bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 [&>option]:text-black"
                >
                  <option value={0}>BUY (long)</option>
                  <option value={1}>SELL (short)</option>
                </select>
              </label>
              <button
                onClick={runProbe}
                disabled={probeLoading || !deploymentId}
                className="px-4 py-2 rounded-md bg-[var(--accent)] text-white text-sm disabled:opacity-50"
              >
                {probeLoading ? "Running..." : "Run probe"}
              </button>
              <button
                onClick={flattenProbe}
                disabled={flattenLoading || !deploymentId}
                className="px-4 py-2 rounded-md border border-[var(--card-border)] text-sm disabled:opacity-50"
                title="POST /api/Position/closeContract for the deployment's contract + account"
              >
                {flattenLoading ? "Flattening..." : "Flatten"}
              </button>
            </div>
            {probeResult != null && (
              <div className="mt-3">
                <div className="text-xs text-[var(--muted)] mb-1">Probe result</div>
                <pre className="text-xs bg-[var(--bg)] border border-[var(--card-border)] rounded-md p-2 overflow-auto max-h-96">
                  {JSON.stringify(probeResult, null, 2)}
                </pre>
              </div>
            )}
            {flattenResult != null && (
              <div className="mt-3">
                <div className="text-xs text-[var(--muted)] mb-1">Flatten result</div>
                <pre className="text-xs bg-[var(--bg)] border border-[var(--card-border)] rounded-md p-2 overflow-auto">
                  {JSON.stringify(flattenResult, null, 2)}
                </pre>
              </div>
            )}
          </section>

          <section className="mb-8 p-4 rounded-lg border border-[var(--card-border)] bg-[var(--card)]">
            <h2 className="text-lg font-semibold mb-3">Probe: trailing stop</h2>
            <p className="text-xs text-[var(--muted)] mb-4">
              Practice account only.{" "}
              <strong>Bracket</strong>: market entry with{" "}
              <code>stopLossBracket.type: 5</code> — confirms Topstep honors trailing bracket.{" "}
              <strong>Standalone</strong>: type=4 SL bracket plus a separate type=5 order, samples{" "}
              <code>stopPrice</code> at 0/15/30/60s.{" "}
              <strong>Promote</strong>: full OCO entry, then cancels the SL and replaces it with
              a standalone type=5 (the production-target flow). Reports whether TP+trail both
              rest cleanly.{" "}
              <strong>OCO test</strong>: runs Promote then forces the trail to fire by tightening
              <code> trailPrice </code>to 10 ticks. Snapshots TP after the fill — answers whether
              Topstep auto-cancels the orphaned TP or leaves it working (would short us on a
              reversal). Position is left open — use Flatten when done.
            </p>
            <div className="flex items-end gap-3 mb-4 flex-wrap">
              <label className="text-sm flex-1 min-w-[12rem]">
                <span className="block text-[var(--muted)] text-xs mb-1">Deployment</span>
                <select
                  value={deploymentId}
                  onChange={(e) => setDeploymentId(e.target.value)}
                  className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 [&>option]:text-black"
                >
                  {practiceDeployments.length === 0 && (
                    <option value="">No practice deployments</option>
                  )}
                  {practiceDeployments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {deploymentLabel(d)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-[var(--muted)] text-xs mb-1">Side</span>
                <select
                  value={trailProbeSide}
                  onChange={(e) => setTrailProbeSide(Number(e.target.value) as OrderSide)}
                  className="bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 [&>option]:text-black"
                >
                  <option value={0}>BUY (long)</option>
                  <option value={1}>SELL (short)</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-[var(--muted)] text-xs mb-1">Mode</span>
                <select
                  value={trailProbeMode}
                  onChange={(e) => setTrailProbeMode(e.target.value as "bracket" | "standalone" | "promote" | "oco-test" | "modify-promote" | "standalone-v2" | "standalone-linked")}
                  className="bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 [&>option]:text-black"
                >
                  <option value="bracket">Bracket</option>
                  <option value="standalone">Standalone (~60s)</option>
                  <option value="promote">Promote SL→trail (~10s)</option>
                  <option value="oco-test">OCO test (fire trail, ~40s)</option>
                  <option value="modify-promote">Modify-promote (~35s)</option>
                  <option value="standalone-v2">Standalone v2 (stopPrice + trailPrice)</option>
                  <option value="standalone-linked">Standalone linked (linkedOrderId)</option>
                </select>
              </label>
              <button
                onClick={runTrailProbe}
                disabled={trailProbeLoading || !deploymentId}
                className="px-4 py-2 rounded-md bg-[var(--accent)] text-white text-sm disabled:opacity-50"
              >
                {trailProbeLoading ? "Running..." : "Run probe"}
              </button>
              <button
                onClick={flattenProbe}
                disabled={flattenLoading || !deploymentId}
                className="px-4 py-2 rounded-md border border-[var(--card-border)] text-sm disabled:opacity-50"
                title="POST /api/Position/closeContract for the deployment's contract + account"
              >
                {flattenLoading ? "Flattening..." : "Flatten"}
              </button>
            </div>
            {trailProbeResult != null && (
              <div className="mt-3">
                <div className="text-xs text-[var(--muted)] mb-1">Probe result</div>
                <pre className="text-xs bg-[var(--bg)] border border-[var(--card-border)] rounded-md p-2 overflow-auto max-h-96">
                  {JSON.stringify(trailProbeResult, null, 2)}
                </pre>
              </div>
            )}
          </section>

          <section className="mb-8 p-4 rounded-lg border border-[var(--card-border)] bg-[var(--card)]">
            <h2 className="text-lg font-semibold mb-3">Probe: place order with dead account id</h2>
            <p className="text-xs text-[var(--muted)] mb-4">
              Sends a bare market order to <code>/api/Order/place</code> using a random
              high-range account id (or one you provide) that doesn&apos;t belong to us.
              Goal: capture the exact error shape Topstep returns so the engine can detect
              when an account disappears mid-session (combine→XFA upgrade) and auto-pause
              orphan deployments.{" "}
              <strong>Safe — Topstep should reject before any order is created.</strong>
            </p>
            <div className="flex items-end gap-3 mb-4">
              <label className="text-sm flex-1">
                <span className="block text-[var(--muted)] text-xs mb-1">
                  Account id (leave blank for a random 90M+ id)
                </span>
                <input
                  type="text"
                  value={deadAcctIdRaw}
                  onChange={(e) => setDeadAcctIdRaw(e.target.value)}
                  placeholder="auto-random"
                  className="w-full bg-[var(--bg)] border border-[var(--card-border)] rounded-md px-2 py-1 font-mono"
                />
              </label>
              <button
                onClick={probeDeadAccount}
                disabled={deadAcctLoading}
                className="px-4 py-2 rounded-md bg-[var(--accent)] text-white text-sm disabled:opacity-50"
              >
                {deadAcctLoading ? "Probing..." : "Probe"}
              </button>
            </div>
            {deadAcctResult != null && (
              <div className="mt-3">
                <div className="text-xs text-[var(--muted)] mb-1">
                  Topstep response (status / headers / body)
                </div>
                <pre className="text-xs bg-[var(--bg)] border border-[var(--card-border)] rounded-md p-2 overflow-auto max-h-96">
                  {JSON.stringify(deadAcctResult, null, 2)}
                </pre>
              </div>
            )}
          </section>

          <section className="premium-card bg-[var(--card)] p-4 border-[var(--danger)]/30">
            <h2 className="text-base font-semibold mb-1 text-[var(--danger)]">Danger zone — clear all trades</h2>
            <p className="text-xs text-[var(--muted)] mb-3">
              Wipes every row in <code>strategy_trades</code> (and the cascading bar
              snapshots). Deployments are untouched. Refused if any trade is in-flight
              (pending_entry / open / pending_exit) — flatten or wait first. Type the
              confirmation phrase exactly to enable the button.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={clearConfirm}
                onChange={(e) => setClearConfirm(e.target.value)}
                placeholder="DELETE ALL TRADES"
                className="flex-1 px-3 py-2 rounded-md bg-[var(--bg)] border border-[var(--card-border)] text-sm font-mono"
              />
              <button
                type="button"
                onClick={clearAllTrades}
                disabled={clearLoading || clearConfirm !== "DELETE ALL TRADES"}
                className="px-4 py-2 rounded-md bg-[var(--danger)] text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {clearLoading ? "Clearing..." : "Clear all trades"}
              </button>
            </div>
            {clearResult != null && (
              <div className="mt-3 text-xs">
                {clearResult.ok ? (
                  <p className="text-[var(--success)]">
                    ✓ Deleted {clearResult.deleted ?? 0} trade(s). Open dashboards refreshed.
                  </p>
                ) : (
                  <p className="text-[var(--danger)]">{clearResult.error ?? "Failed"}</p>
                )}
              </div>
            )}
          </section>
      </div>
    </AppShell>
  );
}
