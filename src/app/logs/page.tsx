"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { EngineStatus } from "@/components/engine-status";
import { EngineLogs } from "@/components/engine-logs";

/**
 * `/logs` — the two-lane viewer. It has no nav tab: it is reached from
 * whatever raised the question. The StatusRail's health cluster is the global
 * link, and a deployment links to its own lines from its board row and its
 * drill-in.
 *
 * `?deployment=<id>` is that second entry point, repeatable so a drill-in can
 * name every leg it is showing. The value is the same one the Diagnostics
 * lane's `deployment` facet groups by, so the URL names something already
 * visible in the strip rather than a private key.
 */
function LogsPageInner() {
  const searchParams = useSearchParams();
  const deploymentIds = searchParams.getAll("deployment");

  return (
    <AppShell>
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Engine Logs</h1>
        <EngineStatus />
        <EngineLogs deploymentIds={deploymentIds} />
      </div>
    </AppShell>
  );
}

export default function LogsPage() {
  return (
    <Suspense fallback={null}>
      <LogsPageInner />
    </Suspense>
  );
}
