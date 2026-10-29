"use client";

import { Chevron } from "@/components/chevron";
import { COLLAPSE_ALL_LABEL, EXPAND_ALL_LABEL } from "@/components/book/book-grid-model";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";

export const HIDE_IDS_LABEL = "ID";
export const HIDE_IDS_TITLE_OFF = "Hide account IDs — every account reads Account 1, 2, 3… on every page.";
export const HIDE_IDS_TITLE_ON = "Account IDs hidden — showing Account 1, 2, 3… Click to show them.";
export const HIDE_BALANCES_LABEL = "$";
export const HIDE_BALANCES_TITLE_OFF =
  "Hide balances — every balance reads $xx,xxx.xx on every page. P&L stays visible.";
export const HIDE_BALANCES_TITLE_ON = "Balances hidden. Click to show them.";

const FOLD_GLYPH_PX = 14;

const SEGMENT = "w-7 h-7 flex items-center justify-center shrink-0 transition-colors";
const SEGMENT_OFF = "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--hover)]";
// The active nav tab's colour: "hidden" reads as pressed, not as an alert.
const SEGMENT_ON = "bg-[var(--active-ui-bg)] text-[var(--foreground)]";
const SEGMENT_TEXT = "font-mono text-[10px] uppercase tracking-wider";

function PrivacySwitch({
  on,
  onToggle,
  label,
  titleOn,
  titleOff,
}: {
  on: boolean;
  onToggle: (next: boolean) => void;
  label: string;
  titleOn: string;
  titleOff: string;
}) {
  const title = on ? titleOn : titleOff;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={title}
      title={title}
      onClick={() => onToggle(!on)}
      className={`${SEGMENT} ${SEGMENT_TEXT} ${on ? SEGMENT_ON : SEGMENT_OFF}`}
    >
      {label}
    </button>
  );
}

/**
 * The page's view cluster: expand/collapse every card (when the page has
 * cards to fold) and the two display-privacy switches, which are global and
 * so the same on every page that carries the cluster.
 */
export function ViewControls({ fold }: { fold?: { allOpen: boolean; onToggle: () => void } }) {
  const { hideAccountIds, hideBalances, setHideAccountIds, setHideBalances } = useDisplayPrivacy();
  return (
    <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-[var(--card-border)] divide-x divide-[var(--card-border)] bg-[var(--card)]">
      {fold != null && (
        <button
          type="button"
          onClick={fold.onToggle}
          aria-label={fold.allOpen ? COLLAPSE_ALL_LABEL : EXPAND_ALL_LABEL}
          title={fold.allOpen ? COLLAPSE_ALL_LABEL : EXPAND_ALL_LABEL}
          className={`${SEGMENT} ${SEGMENT_OFF}`}
        >
          <Chevron expanded={fold.allOpen} size={FOLD_GLYPH_PX} />
        </button>
      )}
      <PrivacySwitch
        on={hideAccountIds}
        onToggle={setHideAccountIds}
        label={HIDE_IDS_LABEL}
        titleOn={HIDE_IDS_TITLE_ON}
        titleOff={HIDE_IDS_TITLE_OFF}
      />
      <PrivacySwitch
        on={hideBalances}
        onToggle={setHideBalances}
        label={HIDE_BALANCES_LABEL}
        titleOn={HIDE_BALANCES_TITLE_ON}
        titleOff={HIDE_BALANCES_TITLE_OFF}
      />
    </div>
  );
}
