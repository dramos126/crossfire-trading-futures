"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ARM_MS } from "@/components/account/account-risk-block";
import type { BoardLegRisk } from "@/components/board/board-model";
import {
  describeContractCount,
  morePlaybooksLabel,
  BOOK_CELL_NOT_IN_BUILD_STAMP,
  BOOK_NO_PLAYBOOKS,
  FEWER_PLAYBOOKS_LABEL,
  REMOVE_BOOK_CONFIRM,
  BOOK_SWITCH_ARMED,
  BOOK_SWITCH_DISARMED,
  BOOK_SWITCH_LABEL,
  type BookGridContract,
  type BookLevelCell,
} from "@/components/book/book-grid-model";
import type { TickerSymbol } from "@/lib/trading/domain";

/**
 * The Books screen's parts, shared by its sections, account cards and
 * dialogs: the contract columns, the checkbox line, the playbook chips, the ⋯
 * menu, the switch, the risk value and the dialog frame. Each renders a
 * decision the model already made.
 */

/** The two button shapes on this screen: the primary execution action, and the way out. */
export const PRIMARY_BUTTON =
  "btn-emerald rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50";
export const SECONDARY_BUTTON =
  "rounded-md border border-[var(--card-border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]";

/** A text control that reads as a link: it opens something on this page rather than leaving it. */
export const LINK_BUTTON =
  "text-xs text-[var(--accent)] underline underline-offset-2 hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50";

/** A label-tier heading inside a dialog. */
export const DIALOG_LABEL = "mb-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]";

/** A checked box's colour is its tone: green only where the engine would act. */
const CHECK_ACCENT: Record<"live" | "muted" | "warn", string> = {
  live: "accent-[var(--success)]",
  muted: "accent-[var(--muted)]",
  warn: "accent-[var(--warning)]",
};

/** The `held`, `idle`, `not in build` and fit stamps: one shape, so the warn states read alike. */
export const WARN_STAMP =
  "rounded-full border border-[var(--warning)]/30 bg-[var(--warning)]/15 px-1.5 text-[10px] uppercase tracking-wide text-[var(--warning)]";

const DANGER_STAMP_SHAPE =
  "rounded-full border border-[var(--danger)]/30 bg-[var(--danger)]/15 px-1.5 py-0.5 text-[10px] tracking-wide text-[var(--danger)]";

/** The refused-account stamp: `no auto-trade`, upper-cased by the class. */
export const DANGER_STAMP = `${DANGER_STAMP_SHAPE} uppercase`;

/** The account-state gate's stamps (`Dead`, `Locked`, `DLL`, `OCO Off`, …) in
 *  the same shape, rendered in the casing the string carries (copy.md). */
export const ACCOUNT_STATE_DANGER_STAMP = DANGER_STAMP_SHAPE;

/** A refused account row's stamp class: the account-state gate's in its own
 *  casing, every other refusal's upper-cased. */
export function refusedStampClass(fromStateGate: boolean): string {
  return fromStateGate ? ACCOUNT_STATE_DANGER_STAMP : DANGER_STAMP;
}

/**
 * Contract columns. `auto-fit` over a 280px minimum, so any number of
 * contracts fills the container, wraps when it must and stacks at phone width;
 * the negative margin hides the outer edge of each column's top and left rule,
 * so only the lines between columns show, wrapped or not.
 */
export function ContractColumns<C extends { ticker: TickerSymbol; strategyKey: string; armed: boolean }>({
  contracts,
  empty,
  renderCell,
}: {
  contracts: ReadonlyArray<BookGridContract<C>>;
  empty: string;
  renderCell: (cell: C) => ReactNode;
}) {
  if (contracts.length === 0) {
    return <p className="px-4 py-3 text-[11px] text-[var(--muted)]">{empty}</p>;
  }
  return (
    <div className="overflow-hidden">
      <div className="-ml-px -mt-px grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))]">
        {contracts.map((contract) => (
          <ContractColumn key={contract.ticker} contract={contract} renderCell={renderCell} />
        ))}
      </div>
    </div>
  );
}

function ContractColumn<C extends { ticker: TickerSymbol; strategyKey: string; armed: boolean }>({
  contract,
  renderCell,
}: {
  contract: BookGridContract<C>;
  renderCell: (cell: C) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const cells = expanded ? contract.cells : contract.shown;
  const tone = contract.allOff ? "text-[var(--muted-secondary)]" : "text-[var(--foreground)]";
  return (
    <div className="border-l border-t border-[var(--card-border)] px-4 py-3">
      <h3 className="mb-1.5 flex items-baseline gap-2 font-mono tabular">
        <span className={`text-xs font-semibold ${tone}`}>{contract.label}</span>
        <span
          className={`text-[11px] ${contract.allOff ? "text-[var(--muted-secondary)]" : "text-[var(--muted)]"}`}
        >
          {describeContractCount(contract)}
        </span>
      </h3>
      <ul>
        {cells.map((cell, idx) => (
          <li
            key={cell.strategyKey}
            className={idx % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"}
          >
            {renderCell(cell)}
          </li>
        ))}
      </ul>
      {contract.hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 min-h-11 px-2 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)] sm:min-h-0"
        >
          {expanded ? FEWER_PLAYBOOKS_LABEL : morePlaybooksLabel(contract.hiddenCount)}
        </button>
      )}
    </div>
  );
}

/**
 * A real checkbox with the whole line as its label, so the label is the hit
 * area. The box's colour is the cell's tone; an off line is muted and says
 * nothing more — the box already says it. `notes` are sentences printed under
 * the label in the warn tone: a fit warning, or why the box cannot be pressed.
 */
export function PlaybookCheckbox({
  checked,
  tone,
  label,
  title,
  inert,
  busy,
  stamps,
  notes,
  onToggle,
}: {
  checked: boolean;
  tone: "live" | "muted" | "warn";
  label: string;
  title: string;
  inert: boolean;
  busy: boolean;
  stamps: readonly string[];
  notes: readonly string[];
  /** The handler asks the model, not the attribute. */
  onToggle: () => void;
}) {
  return (
    <label
      title={title}
      className={`flex min-h-11 flex-col justify-center px-2 py-1.5 sm:block sm:min-h-0 ${inert || busy ? "cursor-not-allowed" : "cursor-pointer hover:bg-[var(--hover)]"}`}
    >
      <span className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={inert || busy}
          onChange={onToggle}
          className={`h-3.5 w-3.5 shrink-0 ${CHECK_ACCENT[tone]}`}
        />
        <span
          className={`min-w-0 truncate text-sm ${checked ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}
        >
          {label}
        </span>
        {stamps.map((stamp) => (
          <span key={stamp} className={WARN_STAMP}>
            {stamp}
          </span>
        ))}
      </span>
      {notes.map((note) => (
        <span key={note} className="mt-1 block pl-5.5 text-[11px] leading-snug text-[var(--warning)]">
          {note}
        </span>
      ))}
    </label>
  );
}

/**
 * A book's definition as chips, grouped by contract: the bare contract, then
 * each playbook as a chip titled with its shelf. Read-only — a book changes in
 * code — and drawn in full, never collapsed.
 */
export function PlaybookChips({ contracts }: { contracts: ReadonlyArray<BookGridContract<BookLevelCell>> }) {
  if (contracts.length === 0) {
    return <p className="text-[11px] text-[var(--muted)]">{BOOK_NO_PLAYBOOKS}</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {contracts.map((contract) => (
        <span key={contract.ticker} className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono tabular text-xs font-semibold text-[var(--foreground)]">{contract.label}</span>
          {contract.cells.map((cell) => (
            <span
              key={cell.strategyKey}
              title={cell.title}
              className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--card-border)] bg-[var(--bg-row)] px-2 py-0.5 text-xs text-[var(--foreground)]"
            >
              {cell.label}
              {!cell.inBuild && <span className={WARN_STAMP}>{BOOK_CELL_NOT_IN_BUILD_STAMP}</span>}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

/** One entry in a ⋯ menu. */
export interface MenuItem {
  label: string;
  title: string;
  /** Inert, with `title` printed under it as text too. */
  inert: boolean;
  /** Destructive: the first press morphs it to *Confirm?*, the second acts. */
  confirm: boolean;
  onPress: () => void;
}

/**
 * The ⋯ menu ([design-language.md](../../../docs/modules/ui/design-language.md),
 * *The ⋯ menu*): an opaque `--bg-surface` panel with a crisp border and no
 * shadow, anchored under the ⋯. A destructive item confirms inline — it morphs
 * to *Confirm?* and disarms itself after the Risk page's `ARM_MS` — and an
 * inert one shows its refusal as text under it, not only as a tooltip. Closes
 * on Escape or a press outside, forgetting a half-made confirm.
 */
export function ActionMenu({ label, items, busy }: { label: string; items: readonly MenuItem[]; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setConfirming(null);
    };
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (confirming == null) return;
    const id = setTimeout(() => setConfirming(null), ARM_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  if (items.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setConfirming(null);
        }}
        className="rounded-md px-1.5 py-0.5 text-base leading-none text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-[var(--card-border)] bg-[var(--bg-surface)] p-1"
        >
          {items.map((item, idx) => {
            const armed = confirming === idx;
            return (
              <div key={item.label}>
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.inert || busy}
                  title={item.title}
                  onClick={() => {
                    if (item.confirm && !armed) {
                      setConfirming(idx);
                      return;
                    }
                    setOpen(false);
                    setConfirming(null);
                    item.onPress();
                  }}
                  className={`w-full rounded-sm px-2 py-1 text-left text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
                    armed
                      ? "border border-[var(--danger)] bg-[var(--danger)]/15 text-[var(--danger)]"
                      : "text-[var(--foreground)] hover:bg-[var(--hover)]"
                  }`}
                >
                  {armed ? REMOVE_BOOK_CONFIRM : item.label}
                </button>
                {item.inert && (
                  <p className="px-2 py-1 text-[11px] leading-snug text-[var(--muted)]">{item.title}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * An account's switch for its book, reading `Armed` / `Disarmed`. The reading
 * is part of the control so the whole of it is the hit area; the accessible
 * name is the label, and `aria-checked` carries the state.
 */
export function BookSwitch({
  enabled,
  title,
  inert,
  busy,
  onPress,
}: {
  enabled: boolean;
  title: string;
  inert: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={BOOK_SWITCH_LABEL}
      onClick={onPress}
      disabled={inert || busy}
      title={title}
      className="group inline-flex items-center gap-2 disabled:cursor-not-allowed"
    >
      <span
        className={`relative inline-flex h-4 w-8 shrink-0 rounded-full border ${
          enabled ? "border-[var(--success)] bg-[var(--success)]/20" : "border-[var(--card-border)] bg-[var(--hover)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-2.5 w-2.5 rounded-full ${
            enabled ? "left-[17px] bg-[var(--success)]" : "left-0.5 bg-[var(--muted)]"
          }`}
        />
      </span>
      <span
        className={`w-16 text-left text-xs font-medium ${enabled ? "text-[var(--success)]" : "text-[var(--muted)]"}`}
      >
        {enabled ? BOOK_SWITCH_ARMED : BOOK_SWITCH_DISARMED}
      </span>
    </button>
  );
}

/**
 * What one entry on this account may lose today. **Every arm is decided in
 * `boardRisk`** — which word, which tone, which blank — so this renders the
 * decision and makes none of it. A refused account's `silent` is never passed
 * here: its line draws neither label nor value.
 */
export function RiskCell({ risk }: { risk: Exclude<BoardLegRisk, { kind: "silent" }> }) {
  if (risk.kind === "pending") {
    return <span className="font-mono tabular text-xs text-[var(--muted)]">…</span>;
  }
  if (risk.kind === "unreadable") {
    return (
      <span className="cursor-help font-mono tabular text-xs text-[var(--muted)]" title={risk.detail}>
        —
      </span>
    );
  }
  if (risk.kind === "blocked") {
    return (
      <span
        title={risk.detail}
        className={`cursor-help rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
          risk.tone === "danger"
            ? "border-[var(--danger)]/30 bg-[var(--danger)]/15 text-[var(--danger)]"
            : "border-[var(--warning)]/30 bg-[var(--warning)]/15 text-[var(--warning)]"
        }`}
      >
        {risk.note}
      </span>
    );
  }
  return (
    <span className="inline-flex cursor-help items-baseline gap-1.5 text-[11px]" title={risk.detail}>
      <span
        className={`rounded-sm border border-[var(--card-border)] px-1.5 py-0.5 font-mono tabular text-xs ${
          risk.tone === "warning" ? "text-[var(--warning)]" : "text-[var(--foreground)]"
        }`}
      >
        {risk.amount}
      </span>
      {risk.note != null && (
        <span className={risk.tone === "warning" ? "text-[var(--warning)]" : "text-[var(--muted-secondary)]"}>
          {risk.note}
        </span>
      )}
    </span>
  );
}

/**
 * The Books dialogs' frame — the Settings reset dialog's shape: a dimmed
 * backdrop, one opaque `--bg-surface` panel with a crisp border and no
 * shadow, the title, the body, and the actions far right. Escape or a press on
 * the backdrop closes it, except while a write is out — closing then would
 * put its answer off-screen. Focus moves in on open, Tab stays inside, and
 * focus goes back to the opener on close.
 */
export function BookDialog({
  title,
  busy,
  onClose,
  actions,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = panel.current;
    if (el) (tabStops(el)[0] ?? el).focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-10"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Tab" || panel.current == null) return;
          const stops = tabStops(panel.current);
          if (stops.length === 0) return;
          const first = stops[0];
          const last = stops[stops.length - 1];
          const at = document.activeElement;
          if (e.shiftKey ? at === first || at === panel.current : at === last) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
          }
        }}
        className="w-full max-w-2xl rounded-lg border border-[var(--card-border)] bg-[var(--bg-surface)] outline-none"
      >
        <h2
          id={titleId}
          className="border-b border-[var(--card-border)] px-4 py-3 text-[15px] font-semibold text-[var(--foreground)]"
        >
          {title}
        </h2>
        <div className="space-y-4 px-4 py-3">{children}</div>
        <div className="flex justify-end gap-2 border-t border-[var(--card-border)] px-4 py-3">{actions}</div>
      </div>
    </div>
  );
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/** The dialog's Tab order. A radio group is one stop — its checked radio, or its first when none is. */
function tabStops(root: HTMLElement): HTMLElement[] {
  const seen = new Set<string>();
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || el.name === "") return true;
    const group = Array.from(root.querySelectorAll<HTMLInputElement>(`input[type='radio'][name='${el.name}']:not([disabled])`));
    const stop = group.find((r) => r.checked) ?? group[0];
    if (stop !== el || seen.has(el.name)) return false;
    seen.add(el.name);
    return true;
  });
}

/**
 * A pick list inside a dialog: one real radio per row, zebra-striped, the
 * whole row the hit area. A refused row is disabled and greyed; its reason is
 * the row's own content, drawn by the caller.
 */
export function PickList<T extends string | number>({
  name,
  options,
  value,
  onPick,
}: {
  name: string;
  options: ReadonlyArray<{ value: T; disabled: boolean; title?: string; content: ReactNode }>;
  value: T | null;
  /** The handler re-checks the row; the attribute is not the guard. */
  onPick: (value: T) => void;
}) {
  return (
    <ul className="overflow-hidden rounded-md border border-[var(--card-border)]">
      {options.map((o, idx) => (
        <li key={String(o.value)} className={idx % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"}>
          <label
            title={o.title}
            className={`flex items-start gap-2 px-3 py-2 ${
              o.disabled ? "cursor-not-allowed text-[var(--muted-secondary)]" : "cursor-pointer hover:bg-[var(--hover)]"
            }`}
          >
            <input
              type="radio"
              name={name}
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onPick(o.value)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
            />
            <span className="min-w-0 flex-1">{o.content}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}
