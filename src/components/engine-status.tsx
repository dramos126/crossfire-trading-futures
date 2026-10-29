"use client";

import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { refreshEngineStatus, useEngineStatus } from "@/lib/hooks/use-engine-status";
import { PulseDot } from "@/components/pulse-dot";

export function EngineStatus() {
  const { token } = useTrading();
  const status = useEngineStatus();
  const running = typeof status?.running === "boolean" ? status.running : null;

  async function stopEngine() {
    if (!token) return;
    await fetch("/api/engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    // The pushed status says so within a second; this read covers a stream
    // that is down.
    void refreshEngineStatus();
  }

  if (!token) return null;

  return (
    <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <PulseDot
          active={!!running}
          color="bg-[var(--success)]"
          label={running ? "Engine running" : "Engine stopped"}
        />
        <p className="text-xs text-[var(--muted)] uppercase tracking-wide">
          Engine {running == null ? "…" : running ? "Running" : "Stopped"}
        </p>
      </div>
      {running && (
        <button
          onClick={stopEngine}
          className="px-3 py-1 text-xs rounded-md bg-[var(--danger)]/20 text-[var(--danger)] hover:bg-[var(--danger)]/30"
        >
          Stop Engine
        </button>
      )}
    </div>
  );
}
