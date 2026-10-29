"use client";

import { InfoIcon } from "@/components/info-icon";
import {
  ADMISSION_HELP,
  CELLS_HELP,
  FAILED_CRITERION_NOTE,
  FOLDS_NOT_PUBLISHED,
  type AdmissionView,
  type CriterionRow,
} from "@/components/playbook/playbook-detail-model";
import { PlaybookSection } from "@/components/playbook/playbook-section";

/**
 * The *Admission* frame: the bar this playbook had to clear, and what it
 * measured against that bar.
 *
 * **A criterion that failed renders `FAIL` in `--danger` and disables
 * nothing.** A playbook can be admitted with a criterion narrowly missed,
 * under a ruling the operator recorded — a page that hid that, or that refused to show the playbook as
 * admitted because a number is red, would be the platform overruling a
 * decision the operator recorded. The red number beside the stamp is the
 * point of the frame.
 *
 * **A pass is not green.** Only the miss is coloured: green on this page
 * would read as the board's *the engine will take an entry here*, and every
 * other number here would then be competing with it.
 */
export function PlaybookAdmissionSection({ view }: { view: AdmissionView }) {
  return (
    <PlaybookSection
      title="Admission"
      help={ADMISSION_HELP}
      right={<span className="font-mono tabular">decided {view.decidedOn}</span>}
    >
      <dl className="mb-4 space-y-2">
        <Fact label="Basis" value={view.basis} />
        <Fact label="Window" value={view.window} />
      </dl>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[var(--card-border)] text-left text-[10px] uppercase tracking-wider text-[var(--muted)]">
            <th className="py-1.5 pr-3 font-medium">Criterion</th>
            <th className="py-1.5 pr-3 font-medium">Bar</th>
            <th className="py-1.5 pr-3 font-medium">Measured</th>
            <th className="py-1.5 text-right font-medium">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {view.criteria.map((c, idx) => (
            <CriterionCells key={c.name} row={c} idx={idx} />
          ))}
        </tbody>
      </table>

      <div className="mt-4">
        <SubLabel label="Folds" />
        {view.folds == null ? (
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
            {FOLDS_NOT_PUBLISHED}
          </p>
        ) : (
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 font-mono tabular text-xs">
            {view.folds.map((f) => (
              <span key={f.label} className="text-[var(--foreground)]">
                {f.label}{" "}
                <span className="text-[var(--muted)]">n {f.n}</span> {f.expectancy}
                {f.t && <span className="text-[var(--muted)]"> {f.t}</span>}
              </span>
            ))}
          </div>
        )}
      </div>

      {view.cells && (
        <div className="mt-4">
          <SubLabel label="Cells" help={CELLS_HELP} />
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 font-mono tabular text-xs">
            {view.cells.map((c) => (
              <span key={c.cell} className="text-[var(--foreground)]">
                {c.cell} <span className="text-[var(--muted)]">n {c.n}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </PlaybookSection>
  );
}

const VERDICT_CLASS: Record<CriterionRow["verdict"], string> = {
  pass: "text-[var(--foreground)]",
  fail: "text-[var(--danger)]",
  open: "text-[var(--warning)]",
};

function CriterionCells({ row, idx }: { row: CriterionRow; idx: number }) {
  const zebra = idx % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]";
  return (
    <tr className={zebra}>
      <td className="py-2 pr-3 pl-2 align-top text-xs font-medium text-[var(--foreground)]">
        {row.name}
      </td>
      <td className="py-2 pr-3 align-top font-mono tabular text-xs text-[var(--muted)]">
        {row.bar}
      </td>
      <td className="py-2 pr-3 align-top font-mono tabular text-xs text-[var(--foreground)]">
        {row.measured}
      </td>
      <td
        className={`py-2 pr-2 text-right align-top font-mono text-xs font-semibold ${VERDICT_CLASS[row.verdict]}`}
        title={row.verdict === "fail" ? FAILED_CRITERION_NOTE : undefined}
      >
        {row.verdictLabel}
      </td>
    </tr>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
      <dt className="w-16 shrink-0 pt-0.5 text-[10px] uppercase tracking-wider text-[var(--muted)]">
        {label}
      </dt>
      <dd className="flex-1 text-xs leading-relaxed text-[var(--foreground)]">{value}</dd>
    </div>
  );
}

function SubLabel({ label, help }: { label: string; help?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--muted)]">
      {label}
      {help && <InfoIcon description={help} />}
    </span>
  );
}
