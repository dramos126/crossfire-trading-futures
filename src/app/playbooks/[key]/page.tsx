"use client";

import { useParams, useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PlaybookDetail } from "@/components/playbook/playbook-detail";

/**
 * `/playbooks/[key]` — one playbook: what it is, and why it is shaped this
 * way.
 *
 * `onBack` goes to the list rather than `router.back()`: back-to-the-list is
 * the affordance, and `back()` would return to wherever the operator came
 * from, which for a bookmark or a pasted link is somewhere else entirely.
 */
export default function PlaybookDetailPage() {
  const params = useParams<{ key: string }>();
  const router = useRouter();
  const key = typeof params.key === "string" ? decodeURIComponent(params.key) : "";

  return (
    <AppShell>
      <PlaybookDetail playbookKey={key} onBack={() => router.push("/playbooks")} />
    </AppShell>
  );
}
