/**
 * Small uppercase label-adjacent pill marking where a field's value came
 * from — `ENV` for an environment variable, `AUTO` for a server default, a
 * broker name on the strategy screen's account rows.
 *
 * Self-contained styling — explicit font-mono / normal-case / muted colour —
 * so it renders identically regardless of the parent label's font and casing.
 */
export function FieldBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 border border-[var(--card-border)] bg-[var(--bg)] rounded-sm text-[10px] font-mono normal-case tracking-normal text-[var(--muted)]">
      {label}
    </span>
  );
}
