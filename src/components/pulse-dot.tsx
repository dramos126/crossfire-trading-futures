/**
 * Shared status-dot primitive — 6px circular indicator with the
 * unified `pulse-dot` animation (3s period, 6px glow, accent color).
 *
 * Use this instead of inline `status-dot-live`, `session-dot-active`,
 * or `accent-dot-pulse` class applications so every active indicator
 * on the page shares the same keyframe and pulses in sync.
 *
 * Props:
 *   active  — when true the dot pulses; when false it renders static
 *             at `--muted` opacity-40.
 *   color   — Tailwind bg-* class for the dot fill (default: accent).
 *             Keep the fill semantically meaningful (green = connected,
 *             accent = section-active) — the pulse glow always uses
 *             `var(--accent)` regardless of fill color.
 *   size    — diameter class (default: "w-1.5 h-1.5").
 *   label   — accessible title/aria-label for the dot span.
 *   className — additional classes forwarded to the outer wrapper.
 */
export function PulseDot({
  active,
  color = "bg-[var(--accent)]",
  size = "w-1.5 h-1.5",
  label,
  className = "",
}: {
  active: boolean;
  color?: string;
  size?: string;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={`block rounded-full shrink-0 ${size} ${
        active ? `${color} status-dot-live` : "bg-[var(--muted)] opacity-40"
      } ${className}`}
      title={label}
      aria-label={label}
      aria-hidden={!label}
    />
  );
}
