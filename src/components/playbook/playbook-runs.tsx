"use client";

import { RUNS_HELP } from "@/components/playbook/playbook-detail-model";
import { PlaybookSection } from "@/components/playbook/playbook-section";

/**
 * The *Runs* frame: every measurement run on this playbook, including the
 * ones that failed.
 *
 * A rejected gate is listed with its verdict so it is not proposed again —
 * which is the whole reason the failures are on screen rather than only the
 * runs that shipped something.
 *
 * **The verdict wraps rather than truncating.** It is the sentence the row
 * exists for, and a truncated verdict is a rejection with its reason cut off.
 */
export function PlaybookRunsSection({
  runs,
}: {
  runs: readonly { id: string; what: string; verdict: string }[];
}) {
  return (
    <PlaybookSection
      title="Runs"
      help={RUNS_HELP}
      right={<span className="font-mono tabular">{runs.length}</span>}
    >
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[var(--card-border)] text-left text-[10px] uppercase tracking-wider text-[var(--muted)]">
            <th className="py-1.5 pl-2 pr-3 font-medium">Run</th>
            <th className="py-1.5 pr-3 font-medium">What</th>
            <th className="py-1.5 pr-2 font-medium">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run, idx) => (
            <tr key={run.id} className={idx % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"}>
              <td className="py-2 pl-2 pr-3 align-top font-mono tabular text-xs text-[var(--muted)]">
                {run.id}
              </td>
              <td className="w-[38%] py-2 pr-3 align-top text-xs leading-relaxed text-[var(--foreground)]">
                {run.what}
              </td>
              <td className="py-2 pr-2 align-top text-xs leading-relaxed text-[var(--muted)]">
                {run.verdict}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </PlaybookSection>
  );
}
