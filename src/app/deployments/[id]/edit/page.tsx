"use client";

import { useParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { DeploymentEditor } from "@/components/deployment/deployment-editor";

/**
 * `/deployments/[id]/edit` — the drill-in's sibling.
 *
 * A thin `AppShell` wrapper, the same shape `page.tsx` next door has: the
 * route resolves the id and the component composes. It reads no search
 * params, so unlike its sibling it needs no `Suspense` boundary.
 */
export default function DeploymentEditPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return (
    <AppShell>
      <DeploymentEditor id={id} />
    </AppShell>
  );
}
