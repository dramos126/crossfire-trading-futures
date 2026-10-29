"use client";

import { useEffect, useId, useRef, useState } from "react";
import { isInBlackoutRange } from "@/lib/trading/session/session";

interface TimeStepInputProps {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  ariaLabel: string;
  modified?: boolean;
  name?: string;
}

const HOLD_DELAY_MS = 400;
const HOLD_INTERVAL_MS = 100;
// One full day: a walk that long visits every minute, so it finds an allowed
// one whatever the blackout ranges are and answers null only when there is
// none. A budget tied to today's width (it was 60 against a 129-minute range)
// is re-broken by the next widening.
const MAX_BLACKOUT_SKIPS = 24 * 60;

type Period = "AM" | "PM";

interface Parts {
  hour12: number;
  minute: number;
  period: Period;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function format24(h: number, m: number): string {
  return `${pad2(h)}:${pad2(m)}`;
}

function parse24(s: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}

function to12(h: number): { hour12: number; period: Period } {
  const period: Period = h < 12 ? "AM" : "PM";
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, period };
}

function to24(hour12: number, period: Period): number {
  const h = hour12 % 12;
  return period === "AM" ? h : h + 12;
}

function partsFrom24(s: string): Parts {
  const parsed = parse24(s);
  if (!parsed) return { hour12: 12, minute: 0, period: "AM" };
  const { hour12, period } = to12(parsed.h);
  return { hour12, minute: parsed.m, period };
}

function partsTo24(p: Parts): string {
  return format24(to24(p.hour12, p.period), p.minute);
}

function totalMinutesFromParts(p: Parts): number {
  const h24 = to24(p.hour12, p.period);
  return h24 * 60 + p.minute;
}

function partsFromTotalMinutes(total: number): Parts {
  const norm = ((total % 1440) + 1440) % 1440;
  const h24 = Math.floor(norm / 60);
  const m = norm % 60;
  const { hour12, period } = to12(h24);
  return { hour12, minute: m, period };
}

function stepWithBlackoutSkip(start: Parts, direction: 1 | -1): Parts | null {
  let total = totalMinutesFromParts(start);
  for (let i = 0; i < MAX_BLACKOUT_SKIPS; i++) {
    total += direction;
    const candidate = partsFromTotalMinutes(total);
    if (!isInBlackoutRange(partsTo24(candidate))) return candidate;
  }
  return null;
}

export function TimeStepInput({
  value,
  onChange,
  readOnly,
  ariaLabel,
  modified,
  name,
}: TimeStepInputProps) {
  const errorId = useId();
  const generatedId = useId();
  const inputId = name ?? generatedId;

  const [parts, setParts] = useState<Parts>(() => partsFrom24(value));
  const [hourText, setHourText] = useState<string>(() => pad2(partsFrom24(value).hour12));
  const [minuteText, setMinuteText] = useState<string>(() => pad2(partsFrom24(value).minute));
  const lastCommittedRef = useRef<string>(value);
  // Mirrors `parts` at every write, for the press-and-hold interval: it is
  // scheduled once, at the press, so a closure over `parts` would re-step from
  // the starting time on every tick and the hold would move exactly once.
  const partsRef = useRef<Parts>(parts);

  const hourRef = useRef<HTMLInputElement>(null);
  const minuteRef = useRef<HTMLInputElement>(null);
  const periodRef = useRef<HTMLButtonElement>(null);

  const holdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The segment this component is currently moving focus off, having already
  // settled its value. `focus()`/`blur()` fire that segment's blur
  // *synchronously*, so the blur handler runs against the render before the
  // keystroke that triggered the move — its `hourText`/`minuteText` still hold
  // the first digit alone, and re-committing them turns a typed "11" into "01".
  // Only ever set across the focus call itself, so a blur the operator causes
  // still commits.
  const settledSegmentRef = useRef<"hour" | "minute" | null>(null);

  useEffect(() => {
    const next = partsFrom24(value);
    partsRef.current = next;
    setParts(next);
    setHourText(pad2(next.hour12));
    setMinuteText(pad2(next.minute));
    lastCommittedRef.current = value;
  }, [value]);

  useEffect(() => {
    return () => {
      if (holdTimeoutRef.current) clearTimeout(holdTimeoutRef.current);
      if (holdIntervalRef.current) clearInterval(holdIntervalRef.current);
    };
  }, []);

  const blackoutHit = isInBlackoutRange(partsTo24(parts));

  function commit(next: Parts) {
    const next24 = partsTo24(next);
    partsRef.current = next;
    setParts(next);
    setHourText(pad2(next.hour12));
    setMinuteText(pad2(next.minute));
    if (isInBlackoutRange(next24)) return;
    if (next24 !== lastCommittedRef.current) {
      lastCommittedRef.current = next24;
      onChange(next24);
    }
  }

  /** Move focus off `segment`, whose value this component has already decided.
   *  The flag is cleared on the way out, so it cannot outlive the one blur
   *  `moveFocus` fires. */
  function leaveSettledSegment(segment: "hour" | "minute", moveFocus: () => void) {
    settledSegmentRef.current = segment;
    moveFocus();
    settledSegmentRef.current = null;
  }

  function revertSegment(seg: "hour" | "minute") {
    if (seg === "hour") setHourText(pad2(parts.hour12));
    else setMinuteText(pad2(parts.minute));
  }

  function commitHourText() {
    const digits = hourText.replace(/\D/g, "");
    if (digits.length === 0) {
      revertSegment("hour");
      return;
    }
    const h = Number(digits);
    if (h < 1 || h > 12) {
      revertSegment("hour");
      return;
    }
    commit({ ...parts, hour12: h });
  }

  function commitMinuteText() {
    const digits = minuteText.replace(/\D/g, "");
    if (digits.length === 0) {
      revertSegment("minute");
      return;
    }
    const m = Number(digits);
    if (m < 0 || m > 59) {
      revertSegment("minute");
      return;
    }
    commit({ ...parts, minute: m });
  }

  function applyStep(direction: 1 | -1) {
    const next = stepWithBlackoutSkip(partsRef.current, direction);
    if (next == null) return;
    commit(next);
  }

  function clearHoldTimers() {
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    if (holdIntervalRef.current) {
      clearInterval(holdIntervalRef.current);
      holdIntervalRef.current = null;
    }
  }

  function startHold(direction: 1 | -1) {
    if (readOnly) return;
    applyStep(direction);
    holdTimeoutRef.current = setTimeout(() => {
      holdIntervalRef.current = setInterval(() => applyStep(direction), HOLD_INTERVAL_MS);
    }, HOLD_DELAY_MS);
  }

  function stepHour(direction: 1 | -1) {
    const total = totalMinutesFromParts(parts) + direction * 60;
    commit(partsFromTotalMinutes(total));
  }

  function stepMinute(direction: 1 | -1) {
    const total = totalMinutesFromParts(parts) + direction;
    commit(partsFromTotalMinutes(total));
  }

  function togglePeriod() {
    commit({ ...parts, period: parts.period === "AM" ? "PM" : "AM" });
  }

  const wrapperBorder = readOnly
    ? "border-[var(--card-border)]"
    : blackoutHit
    ? "border-[var(--danger)] shadow-[0_0_0_1px_var(--danger)]"
    : modified
    ? "border-[var(--accent)] shadow-[0_0_0_1px_var(--accent)]"
    : "border-[var(--card-border)]";

  const segmentClass =
    "bg-transparent border-0 focus:outline-none focus:bg-[var(--card)] rounded-sm text-center text-sm font-mono tabular-nums w-7 px-0.5 py-0 disabled:cursor-not-allowed";

  return (
    <div>
      <div
        className={`relative flex items-center bg-[var(--background)] border rounded-md transition-colors ${wrapperBorder} ${
          readOnly ? "opacity-60" : ""
        }`}
        aria-label={ariaLabel}
        aria-invalid={blackoutHit}
        aria-describedby={blackoutHit ? errorId : undefined}
      >
        <div className="flex items-center px-3 py-2 pr-8 flex-1">
          <input
            ref={hourRef}
            id={inputId}
            type="text"
            inputMode="numeric"
            className={segmentClass}
            value={hourText}
            placeholder="HH"
            disabled={readOnly}
            aria-label={`${ariaLabel} hour`}
            maxLength={2}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 2);
              setHourText(digits);
              if (digits.length === 2) {
                const h = Number(digits);
                if (h >= 1 && h <= 12) {
                  commit({ ...parts, hour12: h });
                  leaveSettledSegment("hour", () => minuteRef.current?.focus());
                }
              }
            }}
            onBlur={() => {
              if (settledSegmentRef.current !== "hour") commitHourText();
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                stepHour(1);
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                stepHour(-1);
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                commitHourText();
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                revertSegment("hour");
                leaveSettledSegment("hour", () => hourRef.current?.blur());
                return;
              }
              if (e.key === ":") {
                e.preventDefault();
                commitHourText();
                leaveSettledSegment("hour", () => minuteRef.current?.focus());
                return;
              }
            }}
          />
          <span className="text-sm font-mono tabular-nums text-[var(--muted)]">:</span>
          <input
            ref={minuteRef}
            type="text"
            inputMode="numeric"
            className={segmentClass}
            value={minuteText}
            placeholder="MM"
            disabled={readOnly}
            aria-label={`${ariaLabel} minute`}
            maxLength={2}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 2);
              setMinuteText(digits);
              if (digits.length === 2) {
                const m = Number(digits);
                if (m >= 0 && m <= 59) {
                  commit({ ...parts, minute: m });
                  leaveSettledSegment("minute", () => periodRef.current?.focus());
                }
              }
            }}
            onBlur={() => {
              if (settledSegmentRef.current !== "minute") commitMinuteText();
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                stepMinute(1);
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                stepMinute(-1);
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                commitMinuteText();
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                revertSegment("minute");
                leaveSettledSegment("minute", () => minuteRef.current?.blur());
                return;
              }
            }}
          />
          <button
            ref={periodRef}
            type="button"
            disabled={readOnly}
            aria-label={`${ariaLabel} period`}
            className="ml-1.5 px-1.5 py-0.5 text-xs font-mono tabular-nums rounded-sm bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--card-border)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] disabled:cursor-not-allowed"
            onClick={togglePeriod}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                togglePeriod();
                return;
              }
              if (e.key === "a" || e.key === "A") {
                e.preventDefault();
                if (parts.period !== "AM") togglePeriod();
                return;
              }
              if (e.key === "p" || e.key === "P") {
                e.preventDefault();
                if (parts.period !== "PM") togglePeriod();
                return;
              }
            }}
          >
            {parts.period}
          </button>
        </div>
        <div
          className={`absolute right-0 inset-y-0 flex flex-col border-l border-[var(--card-border)] ${
            readOnly ? "pointer-events-none" : ""
          }`}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label="Increase time"
            onMouseDown={(e) => {
              e.preventDefault();
              startHold(1);
            }}
            onMouseUp={clearHoldTimers}
            onMouseLeave={clearHoldTimers}
            className="w-7 flex-1 flex items-center justify-center text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card)] transition-colors text-[10px] leading-none"
          >
            ▲
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Decrease time"
            onMouseDown={(e) => {
              e.preventDefault();
              startHold(-1);
            }}
            onMouseUp={clearHoldTimers}
            onMouseLeave={clearHoldTimers}
            className="w-7 flex-1 flex items-center justify-center text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card)] transition-colors text-[10px] leading-none"
          >
            ▼
          </button>
        </div>
      </div>
      {blackoutHit && (
        <p id={errorId} className="text-xs text-[var(--danger)] mt-1">
          Outside allowed session window
        </p>
      )}
    </div>
  );
}
