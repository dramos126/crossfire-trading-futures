"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Hover/focus tooltip primitive. Wrapper around a single child element —
 * we attach event listeners directly via React's onMouseEnter/Leave/Focus/
 * Blur on a host span so we don't have to clone the child or fight with
 * forwarded refs. The trade-off: an extra inline-flex span sits in the DOM,
 * but it inherits no styles and doesn't disrupt layout for the inputs and
 * badges 6b uses today.
 *
 * Triggers:
 *  - Hover: 150ms open delay, instant close on mouseleave
 *  - Focus: instant open + close (keyboard users want immediacy)
 *  - Escape: hides the tooltip
 *  - Click: NOT a trigger — use a Popover for click-pinned panels
 *
 * Positioning is pure-CSS-fixed + JS measurement on open. No
 * floating-ui dependency; the dashboard's tooltips today are short and
 * sit on small targets, so a simple top-vs-bottom auto-flip with viewport
 * clamping is enough.
 */

type Placement = "top" | "bottom";

interface TooltipProps {
  content: React.ReactNode;
  placement?: Placement;
  children: React.ReactElement;
}

const OPEN_DELAY_MS = 150;
const VIEWPORT_MARGIN_PX = 8;

export function Tooltip({ content, placement = "top", children }: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; actualPlacement: Placement }>({
    top: 0,
    left: 0,
    actualPlacement: placement,
  });

  const cancelOpenTimer = () => {
    if (openTimer.current != null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  const computePosition = () => {
    const trigger = triggerRef.current;
    const tip = tooltipRef.current;
    if (!trigger || !tip) return;
    const t = trigger.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    // Auto-flip: prefer the requested placement, but if it would clip
    // off the top/bottom of the viewport flip to the opposite side.
    let actual: Placement = placement;
    if (placement === "top" && t.top - h - VIEWPORT_MARGIN_PX < 0) actual = "bottom";
    if (placement === "bottom" && t.bottom + h + VIEWPORT_MARGIN_PX > window.innerHeight) actual = "top";
    const top =
      actual === "top" ? t.top - h - VIEWPORT_MARGIN_PX : t.bottom + VIEWPORT_MARGIN_PX;
    // Center horizontally on the trigger, then clamp to the viewport
    // with the same 8px margin to keep the tooltip readable on edges.
    let left = t.left + t.width / 2 - w / 2;
    if (left < VIEWPORT_MARGIN_PX) left = VIEWPORT_MARGIN_PX;
    if (left + w > window.innerWidth - VIEWPORT_MARGIN_PX) {
      left = window.innerWidth - w - VIEWPORT_MARGIN_PX;
    }
    setCoords({ top, left, actualPlacement: actual });
  };

  // Recompute on open + scroll/resize while open. Passive listeners + tear
  // down on close so the recompute cost only exists when something is
  // visible.
  useEffect(() => {
    if (!open) return;
    computePosition();
    const onScroll = () => computePosition();
    const onResize = () => computePosition();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelOpenTimer();
        setOpen(false);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
    // computePosition reads refs + state setters — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    return () => cancelOpenTimer();
  }, []);

  const onPointerEnter = () => {
    cancelOpenTimer();
    openTimer.current = window.setTimeout(() => {
      setOpen(true);
    }, OPEN_DELAY_MS);
  };
  const onPointerLeave = () => {
    cancelOpenTimer();
    setOpen(false);
  };
  const onFocus = () => {
    cancelOpenTimer();
    setOpen(true);
  };
  const onBlur = () => {
    cancelOpenTimer();
    setOpen(false);
  };

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={onPointerEnter}
        onMouseLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        aria-describedby={open ? id : undefined}
        className="inline-flex"
      >
        {children}
      </span>
      {open && (
        <div
          ref={tooltipRef}
          id={id}
          role="tooltip"
          style={{ position: "fixed", top: coords.top, left: coords.left, zIndex: 50 }}
          className="pointer-events-none border border-[var(--card-border)] bg-[var(--card)] text-[var(--foreground)] text-xs font-mono px-2 py-1 rounded-md shadow-lg max-w-xs"
        >
          {content}
        </div>
      )}
    </>
  );
}
