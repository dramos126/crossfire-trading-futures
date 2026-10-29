/**
 * The row's leading-glyph slot: three primitives, one 16px footprint, so a
 * list mixing them keeps a single left column. <Chevron> expands in place,
 * <DrillInArrow> navigates away, <ChevronEmpty> holds the slot for a row that
 * does neither.
 *
 * Apple-style disclosure chevron. Single primitive used everywhere
 * a section / row / card collapses inline (NOT for navigation drill-in —
 * that is <DrillInArrow> below).
 *
 * Renders `∨` at 16px and rotates between -90deg (collapsed, points
 * right) and 0deg (expanded, points down) with a 150ms transition —
 * the rotation is the readability win, not the glyph itself, since
 * peripheral vision picks up motion vectors better than static shape.
 *
 * Color inherits via currentColor; pass tone through `className`
 * (e.g. `text-[var(--muted)]`).
 */
export function Chevron({
  expanded,
  className,
  size = 16,
}: {
  expanded: boolean;
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{
        transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
        transition: "transform 150ms ease",
      }}
    >
      <polyline points="4,6 8,10 12,6" />
    </svg>
  );
}

/**
 * Navigation drill-in, in the same alignment slot as <Chevron>.
 *
 * **A row that goes somewhere may not wear the disclosure glyph.** A
 * collapsed <Chevron> and a static right-pointing one are the same shape, so
 * a row that navigates would be indistinguishable from a row that expands —
 * and the two have different costs: one is undone by clicking again, the
 * other by the back button. The arrow says *leaves this page*.
 *
 * Same 16px footprint and stroke weight as <Chevron> so a list holding both
 * keeps one leading column. Colour inherits via currentColor.
 */
export function DrillInArrow({
  className,
  size = 16,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <line x1="3" y1="8" x2="12" y2="8" />
      <polyline points="8.5,4.5 12,8 8.5,11.5" />
    </svg>
  );
}

/**
 * Empty-state indicator that sits in the same alignment slot as
 * <Chevron>. Used where a row would otherwise show a chevron but
 * there is nothing to expand (e.g. a deployment with zero trades).
 * Same 16px footprint and stroke weight as Chevron so the column
 * stays visually aligned across rows.
 */
export function ChevronEmpty({
  className,
  size = 16,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden="true"
      className={className}
      style={{ opacity: 0.5 }}
    >
      <circle cx="8" cy="8" r="3" />
    </svg>
  );
}
