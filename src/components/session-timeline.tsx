"use client";

import type { MainSession, PauseWindow } from "@/lib/trading/strategy-types";
import { parseHHMM } from "@/lib/trading/session/session";

interface SessionTimelineProps {
  main: MainSession;
  pauses: ReadonlyArray<PauseWindow>;
  /** Optional override; defaults to a sensible fixed width that scales
   *  with the parent via 100% width. */
  className?: string;
}

const DAY_MIN = 24 * 60;
const TICK_HOURS = [0, 6, 12, 18, 24];

/**
 * 24h horizontal session bar shared across the Strategies screen,
 * Deploy modal, and the Session-schedule editor.
 *
 * Render order (back-to-front):
 *   - track background (`--bg-row-alt`)
 *   - main session segments (`--accent/30`)
 *   - pause windows cut into the main fill (`--bg-row-deep`)
 *   - hour ticks (00:00, 06:00, 12:00, 18:00) with monospace labels.
 *
 * Overnight main sessions wrap correctly by emitting two segments
 * (e.g. 18:00–24:00 and 00:00–04:00) both highlighted. Pure SVG, no
 * chart library.
 */
export function SessionTimeline({ main, pauses, className }: SessionTimelineProps) {
  const segments = computeMainSegments(main);
  const pauseSegs = pauses.flatMap((p) => splitWraparound(p.start, p.end));

  return (
    <div className={className}>
      <svg
        viewBox="0 0 1440 32"
        preserveAspectRatio="none"
        className="block w-full h-8"
        role="img"
        aria-label="Session schedule timeline"
      >
        <rect x={0} y={0} width={1440} height={8} fill="var(--bg-row-alt)" stroke="var(--card-border)" />
        {segments.map((s, i) => (
          <rect
            key={`m-${i}`}
            x={s.start}
            y={0}
            width={s.end - s.start}
            height={8}
            fill="var(--accent)"
            opacity={0.3}
          />
        ))}
        {pauseSegs.map((s, i) => (
          <rect
            key={`p-${i}`}
            x={s.start}
            y={0}
            width={s.end - s.start}
            height={8}
            fill="var(--bg-row-deep)"
          />
        ))}
        {TICK_HOURS.map((h) => {
          const x = Math.min(h * 60, 1440);
          return (
            <line
              key={`t-${h}`}
              x1={x}
              y1={8}
              x2={x}
              y2={12}
              stroke="var(--card-border)"
              strokeWidth={1}
            />
          );
        })}
        {TICK_HOURS.map((h) => {
          const x = Math.min(h * 60, 1440);
          const label = `${String(h % 24).padStart(2, "0")}:00`;
          return (
            <text
              key={`l-${h}`}
              x={x}
              y={26}
              fontSize={10}
              fontFamily="monospace"
              fill="var(--muted)"
              textAnchor={h === 0 ? "start" : h === 24 ? "end" : "middle"}
            >
              {label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

interface PixelSegment {
  start: number;
  end: number;
}

function computeMainSegments(main: MainSession): PixelSegment[] {
  return splitWraparound(main.start, main.end);
}

function splitWraparound(startHHMM: string, endHHMM: string): PixelSegment[] {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  if (start == null || end == null) return [];
  if (start === end) return [];
  if (start < end) return [{ start, end }];
  // Overnight: emit head [start, 1440) and tail [0, end)
  return [
    { start, end: DAY_MIN },
    { start: 0, end },
  ];
}
