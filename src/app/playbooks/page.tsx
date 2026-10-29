"use client";

import { AppShell } from "@/components/app-shell";
import { PlaybookList } from "@/components/playbook/playbook-list";
import { PLAYBOOKS_SUBTITLE } from "@/components/playbook/playbook-detail-model";

/**
 * `/playbooks` — the list, and nothing else.
 *
 * A route per playbook rather than selection state here, matching
 * `/deployments/[id]`, so a row is linkable,
 * bookmarkable and middle-clickable and browser-back has its ordinary
 * meaning. Nothing on this page reads search params, so it needs no
 * `Suspense` boundary.
 */
export default function PlaybooksPage() {
  return (
    <AppShell>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Playbooks</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">
          {PLAYBOOKS_SUBTITLE}
        </p>
      </div>
      <PlaybookList />
    </AppShell>
  );
}
