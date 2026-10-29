"use client";

import { useMemo, useState } from "react";
import { SAVED_RUNS_HELP } from "@/components/backtest/backtest-run-model";
import { BacktestRunsPanel } from "@/components/backtest/backtest-runs-panel";
import { IntentBadges } from "@/components/intent-badges";
import { PlaybookAdmissionSection } from "@/components/playbook/playbook-admission";
import { PlaybookConstantsSection } from "@/components/playbook/playbook-constants";
import {
  buildAdmissionView,
  buildConstantRows,
  buildPlaybookHeader,
  NO_CALIBRATION_NOTE,
} from "@/components/playbook/playbook-detail-model";
import { PlaybookDeployButton, PlaybookDeployPanel } from "@/components/playbook/playbook-deploy";
import { playbookDeployTarget } from "@/components/playbook/playbook-deploy-model";
import { PlaybookRunsSection } from "@/components/playbook/playbook-runs";
import { PlaybookSection } from "@/components/playbook/playbook-section";
import { AdmissionStampBadge, NoBookStamp, TestFixtureStamp } from "@/components/playbook/playbook-stamp";
import { PlaybookTrySettings } from "@/components/playbook/playbook-try-settings";
import { getStrategy } from "@/lib/trading/strategies";

/**
 * `/playbooks/[key]` — what a playbook *is* and why it is shaped this way,
 * and the one control that runs it on an account.
 *
 * The reading is read-only, and that is structural rather than a restraint:
 * the calibration constants are fixed in code and a value that wants to
 * change is a new measurement first, so nothing on this page edits the
 * playbook. **Deploy takes one choice, an account**, for the same reason —
 * see `playbook-deploy.tsx`. It is the standalone path: a book runs vetted
 * playbooks together, and this runs one, including a test fixture on staging.
 *
 * Three frames, each rendering one typed declaration and reading no file:
 * *Admission* from `config.admission`, *Constants* from `config.calibration`,
 * *Runs* from the admission entry's own run list. **A playbook with neither
 * declaration renders its config, its intent badge and one muted line** — no
 * empty frame, no placeholder table, no `—`, because absence of a measurement
 * is not a reading that failed to resolve.
 *
 * *Try settings* is the one form, and it changes nothing it does not own: it
 * runs the playbook in the browser on edited settings, saves nothing, and
 * exports the backtest command that would — see `playbook-try-settings.tsx`.
 * *Saved Runs* below it is the run reader, the part of the page that reads
 * artifacts — through `/api/backtest/runs`, scoped on each run header's
 * `playbookKey`. Both render for every playbook: *Saved Runs* because its
 * empty state says where runs come from, *Try settings* because a playbook
 * with no instrument says why there is nothing to run it on.
 *
 * It names no file and no path. What it renders instead is the date each
 * number was decided on, which is the fact an operator checks a reading's age
 * against.
 */
export function PlaybookDetail({
  playbookKey,
  onBack,
}: {
  playbookKey: string;
  onBack: () => void;
}) {
  const playbook = getStrategy(playbookKey);
  const header = useMemo(
    () => (playbook ? buildPlaybookHeader(playbookKey, playbook) : null),
    [playbook, playbookKey],
  );
  const constants = useMemo(
    () => buildConstantRows(playbook?.config.calibration),
    [playbook],
  );
  const admission = useMemo(
    () => (playbook?.config.admission ? buildAdmissionView(playbook.config.admission) : null),
    [playbook],
  );
  const deployTarget = useMemo(
    () => (playbook ? playbookDeployTarget(playbook) : null),
    [playbook],
  );
  const [deployOpen, setDeployOpen] = useState(false);

  if (!playbook || !header || !deployTarget) {
    return (
      <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] p-8 text-center">
        <p className="mb-4 text-[var(--muted)]">No playbook is installed under &quot;{playbookKey}&quot;.</p>
        <BackButton onBack={onBack} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="border-b border-[var(--card-border)] pb-5">
        <BackButton onBack={onBack} />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {/* Entity tier: a playbook titles its own surface. */}
          <h2 className="text-2xl font-semibold tracking-tight">{header.name}</h2>
          <IntentBadges intent={header.intent} />
          {header.isTest && <TestFixtureStamp />}
          {header.inNoBook && <NoBookStamp />}
          {/* Context → action: the stamp, then the primary execution action
              anchored far right. */}
          <span className="ml-auto flex items-center gap-3">
            {header.stamp && <AdmissionStampBadge stamp={header.stamp} />}
            <PlaybookDeployButton
              target={deployTarget}
              open={deployOpen}
              onOpen={() => setDeployOpen(true)}
            />
          </span>
        </div>

        <p className="mt-1 font-mono tabular text-[11px] text-[var(--muted)]">
          {[
            header.key,
            `v${header.version}`,
            header.instrument,
            header.timeframeLabel,
            header.sessionLabel,
            header.entryTypeLabel,
            ...header.indicatorChips,
          ]
            .filter((part): part is string => part != null)
            .join(" · ")}
        </p>

        {header.description && (
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">
            {header.description}
          </p>
        )}

        {/* Informational, never warn: this page holds no account, so there is
            no budget to compare the minimum against. */}
        {header.minimumRisk && (
          <div
            data-testid="playbook-minimum-risk"
            className="mt-3 max-w-3xl space-y-1.5 border border-[var(--card-border)] bg-[var(--card)] px-4 py-2 text-[11px] leading-relaxed text-[var(--muted)]"
          >
            {header.minimumRisk.text.split("\n\n").map((block) => (
              <p key={block}>{block}</p>
            ))}
          </div>
        )}
      </div>

      {deployOpen && deployTarget.kind === "ready" && (
        <PlaybookDeployPanel
          playbookKey={playbookKey}
          playbookName={header.name}
          module={playbook}
          target={deployTarget}
          sessionLabel={header.sessionLabel}
          isTest={header.isTest}
          onClose={() => setDeployOpen(false)}
        />
      )}
      {admission && <PlaybookAdmissionSection view={admission} />}
      {constants.length > 0 ? (
        <PlaybookConstantsSection rows={constants} />
      ) : (
        <p className="text-xs text-[var(--muted)]">{NO_CALIBRATION_NOTE}</p>
      )}
      {admission && admission.runs.length > 0 && <PlaybookRunsSection runs={admission.runs} />}
      <PlaybookTrySettings key={playbookKey} playbookKey={playbookKey} module={playbook} />
      {/* Rendered for every playbook, declarations or not: it reads saved
          runs rather than a declaration, and its own empty state names
          where runs come from. */}
      <PlaybookSection title="Saved Runs" help={SAVED_RUNS_HELP}>
        <BacktestRunsPanel strategyKey={playbookKey} />
      </PlaybookSection>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="-ml-3 inline-flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:border-[var(--card-border)] hover:bg-[var(--bg-row)] hover:text-[var(--foreground)]"
    >
      <svg
        aria-hidden
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M19 12H5" />
        <path d="M12 19l-7-7 7-7" />
      </svg>
      <span>All Playbooks</span>
    </button>
  );
}
