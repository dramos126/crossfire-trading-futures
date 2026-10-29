"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { DeploymentDetail } from "@/components/deployment/deployment-detail";

/**
 * `/deployments/[id]` — one deployment's history and long-lived stats.
 *
 * A route rather than an expand: it is linkable and bookmarkable, browser-back
 * means what it should, and it is the only version an alert could ever
 * deep-link to. The page carries its own `← Dashboard` affordance rather than
 * relying on the nav, which would forget where the operator came from.
 *
 * `?account=` preselects one leg of a multi-account deployment. It is read
 * once as the initial selection rather than being kept in sync with the
 * filter: the URL is where a link *lands*, and rewriting it on every filter
 * press would put a history entry behind each one.
 */
function DeploymentDetailPageInner() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const accountRaw = searchParams.get("account");
  const accountId = accountRaw != null && /^\d+$/.test(accountRaw) ? Number(accountRaw) : null;
  const id = typeof params.id === "string" ? params.id : "";

  return (
    <AppShell>
      <DeploymentDetail id={id} initialAccountId={accountId} />
    </AppShell>
  );
}

export default function DeploymentDetailPage() {
  return (
    <Suspense fallback={null}>
      <DeploymentDetailPageInner />
    </Suspense>
  );
}
