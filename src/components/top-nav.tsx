"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NotificationsToggle } from "@/components/notifications-toggle";
import { ViewControls } from "@/components/privacy/view-controls";
import { useSystemHealth, type SystemTone } from "@/lib/hooks/use-system-health";
import { isProductionEnv } from "@/lib/env";
import { PulseDot } from "@/components/pulse-dot";

interface NavItem {
  href: string;
  label: string;
  /** The item stays current on every path under it (`/settings/...`). */
  ownsSubpaths?: boolean;
}

const navItems: readonly NavItem[] = [
  // The two absences are decisions. Deployments: the Dashboard *is* the
  // deployment board, so a tab would be a second door onto the same rows and
  // `/deployments/:id` is a drill-in reached from a card. Logs: it is reached
  // from the system state that raised the question — the StatusRail's health
  // cluster globally, a deployment's own row for the filtered view — so a tab
  // would be a destination for a surface nobody navigates to cold. A nav entry
  // for either would imply a list page that no longer exists.
  //
  // Three is the floor rather than a target to beat: watch what is running,
  // decide what to run, configure the platform are three different jobs.
  //
  // **Books and Playbooks landed together, and neither is reachable from
  // anything else.** Books is where an account is turned on against an
  // instrument; Playbooks is the reading it is armed from, and the grid's
  // cells are controls rather than links, so nothing on that screen can double
  // as the door to this one. They are two jobs — *what should run* and *what
  // is this* — for the same reason Playbooks and the Dashboard are two.
  //
  // There is no Strategies tab: a playbook's own page describes it, deploys
  // it and runs it, and the old route redirects there (`next.config.ts`).
  { href: "/", label: "Dashboard" },
  { href: "/books", label: "Books" },
  { href: "/playbooks", label: "Playbooks" },
  // Settings is a menu of sub-pages, so the tab stays current on all of them.
  { href: "/settings", label: "Settings", ownsSubpaths: true },
  // Dev tab is hidden unless DEV_TOOLS_ENABLED is opt-in. Server-side
  // middleware (src/middleware.ts) blocks the page + API routes too, but
  // we also hide the nav entry so the link doesn't sit there returning 404.
  ...(process.env.NEXT_PUBLIC_DEV_TOOLS_ENABLED === "true" ? [{ href: "/dev", label: "Dev" }] : []),
];

/** The pill's dot by tone — the header's and the status rail's. */
export const TONE_TO_DOT: Record<SystemTone, string> = {
  ok: "bg-[var(--success)]",
  warn: "bg-[var(--warning)]",
  danger: "bg-[var(--danger)]",
  muted: "bg-[var(--muted)]",
};

const TONE_TO_TEXT: Record<SystemTone, string> = {
  ok: "text-[var(--success)]",
  warn: "text-[var(--warning)]",
  danger: "text-[var(--danger)]",
  muted: "text-[var(--muted)]",
};

// Build-time signal — inlined by `next build` so the chrome resolves
// without a render hop. Any non-prod env (staging today, undefined for
// `npm run dev`, future envs later) gets the amber treatment so the
// operator can't miss they're not on prod.
const IS_NON_PROD = !isProductionEnv();

export const MENU_LABEL = "Menu";
export const CLOSE_MENU_LABEL = "Close menu";
export const LOGS_LABEL = "Logs";
export const PRIVACY_ROW_LABEL = "Hide IDs and balances";
export const NOTIFICATIONS_ROW_LABEL = "Alerts to Discord";

const DRAWER_ID = "top-nav-drawer";
// The brand's own colours — the only colours in the UI that are not tokens,
// because the tile is the same on every surface and theme. They are the
// lockup's (`src/app/_brand/crossfire-lockup.svg`).
const BRAND_GREEN = "#1fb87a";
const BRAND_TILE = "#141920";
const BRAND_WHITE = "#e6e6e6";
export const WORDMARK = "Crossfire";
export const WORDMARK_LINE_2 = "TRADING · FUTURES";

/**
 * The Crossfire tile: two candlesticks crossing, a filled green up-bar over a
 * hollow down-bar, on an outlined navy tile. It is the icon half of
 * `crossfire-lockup.svg`, inlined so the header needs no image request;
 * 36px on a phone, 40px from `sm` — sized against the page title's `text-2xl`,
 * which the first cut (28/32) sat visibly under (operator, 2026-10-28).
 */
function BrandTile() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className="shrink-0 w-9 h-9 sm:w-10 sm:h-10">
      <rect x="2" y="2" width="60" height="60" rx="14" fill={BRAND_TILE} stroke={BRAND_GREEN} strokeWidth="2" />
      <g transform="rotate(-30 32 32)">
        <line x1="32" y1="10" x2="32" y2="54" stroke={BRAND_GREEN} strokeWidth="3" />
        <rect x="26" y="20" width="12" height="20" rx="2" fill={BRAND_GREEN} />
      </g>
      <g transform="rotate(30 32 32)">
        <line x1="32" y1="10" x2="32" y2="54" stroke={BRAND_WHITE} strokeWidth="3" />
        <rect x="26" y="26" width="12" height="16" rx="2" fill={BRAND_TILE} stroke={BRAND_WHITE} strokeWidth="3" />
      </g>
    </svg>
  );
}
const MENU_GLYPH_PX = 18;
const LOGS_ITEM: NavItem = { href: "/logs", label: LOGS_LABEL, ownsSubpaths: true };

const NAV_ACTIVE = "bg-[var(--active-ui-bg)] text-[var(--foreground)] font-medium";
const NAV_IDLE = "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--hover)]";

function isNavItemActive(item: NavItem, pathname: string): boolean {
  return pathname === item.href || (item.ownsSubpaths === true && pathname.startsWith(`${item.href}/`));
}

function MenuGlyph({ open }: { open: boolean }) {
  return (
    <svg
      width={MENU_GLYPH_PX}
      height={MENU_GLYPH_PX}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      aria-hidden="true"
    >
      {open ? <path d="M4 4l10 10M14 4L4 14" /> : <path d="M3 5h12M3 9h12M3 13h12" />}
    </svg>
  );
}

const GLYPH_BUTTON_CLASS =
  "w-11 h-11 flex items-center justify-center rounded-md text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--hover)]";

/**
 * The lockup — the tile beside a two-line wordmark, `Crossfire` over
 * `TRADING · FUTURES` — shared by the header and the drawer's top row. The
 * text is HTML rather than the SVG's `<text>` so it sets in the app's font
 * and stays crisp; the proportions are the lockup file's. First run's setup
 * screen carries it too, since that screen has no header.
 */
export function Lockup() {
  return (
    <>
      <BrandTile />
      <span className="flex flex-col justify-center gap-[3px]">
        <span className="text-lg sm:text-xl font-bold tracking-tight leading-none">{WORDMARK}</span>
        <span className="text-[10px] sm:text-[11px] tracking-[0.2em] leading-none text-[var(--muted)]">
          {WORDMARK_LINE_2}
        </span>
      </span>
    </>
  );
}

/**
 * The phone's navigation: a 44px button at the header's left edge that opens a
 * full-height drawer from the left, over a scrim, holding what the 48px header
 * has no room for. Opaque `--bg-surface`, a crisp right border, no shadow;
 * Escape, a scrim press, a link press or a route change closes it.
 * `status` is the health line the header reduces to a bare dot on a phone.
 */
export function TopNavDrawer({
  items,
  pathname,
  status,
}: {
  items: readonly NavItem[];
  pathname: string;
  status: ReactNode;
}) {
  // Open is keyed to the path it was opened on, so any route change — a link
  // here, the back button, a link on the page — closes it with no effect.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenedOn(null);
    };
    const { body } = document;
    const prevOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      body.style.overflow = prevOverflow;
    };
  }, [open]);

  const close = () => setOpenedOn(null);

  return (
    <>
      <button
        type="button"
        aria-label={MENU_LABEL}
        aria-expanded={open}
        aria-controls={DRAWER_ID}
        onClick={() => setOpenedOn(open ? null : pathname)}
        // `-mr-2` as well as `-ml-2`: the 44px box centres an 18px glyph, so
        // the header's gap alone left ~28px of empty box and gap before the tile.
        className={`${GLYPH_BUTTON_CLASS} -ml-2 -mr-2`}
      >
        <MenuGlyph open={false} />
      </button>
      {/* Portalled to the body: the header's backdrop-filter makes it the
          containing block for fixed children, which would clip the drawer to
          the header's 48px. */}
      {open &&
        createPortal(
          <>
            <div
              aria-hidden="true"
              data-top-nav-scrim=""
              onClick={close}
              className="fixed inset-0 z-50 bg-black/60"
            />
            <nav
              id={DRAWER_ID}
              aria-label={MENU_LABEL}
              className="fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] flex-col border-r border-[var(--card-border)] bg-[var(--bg-surface)]"
            >
              <div className="h-12 shrink-0 px-4 flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <Lockup />
                </span>
                <button type="button" aria-label={CLOSE_MENU_LABEL} onClick={close} className={`${GLYPH_BUTTON_CLASS} -mr-2`}>
                  <MenuGlyph open />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-1">
                <div className="flex items-center gap-2 px-3 py-2">{status}</div>
                {[...items, LOGS_ITEM].map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={close}
                    className={`flex h-11 items-center rounded-md px-3 text-sm transition-colors ${
                      isNavItemActive(item, pathname) ? NAV_ACTIVE : NAV_IDLE
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
                <div className="my-1 h-px bg-[var(--card-border)]" />
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-[var(--muted)]">{PRIVACY_ROW_LABEL}</span>
                  <ViewControls />
                </div>
                {/* Mounted only while open, because it reads /api/settings on mount. */}
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-[var(--muted)]">{NOTIFICATIONS_ROW_LABEL}</span>
                  <NotificationsToggle showLabel={false} />
                </div>
              </div>
            </nav>
          </>,
          document.body,
        )}
    </>
  );
}

/**
 * Sticky top nav — brand on the left, route links centered-ish, system
 * cluster on the right (notifications + connection pill).
 * On non-prod environments (staging, etc.) the header gets a 2px amber
 * top-border + faint outer glow — same visual language the practice-mode
 * toggle used, just driven by env now that the toggle is gone.
 *
 * **48px on a phone, 64px from `sm` up.** With the 32px rail below it the
 * chrome was spending 96px of fixed height, which is a rounding error on a
 * monitor and a large fraction of a phone viewport; the rail drops to 28px on
 * the same breakpoint, taking the pair to 76px.
 *
 * **The notifications toggle comes off the phone header and nothing is lost.**
 * It and the toggle on Settings' Notifications page are the same control —
 * both read and write `app_settings.notifications_enabled` through
 * `/api/settings` — and below `sm` it lives in the menu drawer instead. The
 * connection pill stays, because it is the only always-on statement of
 * whether the engine is talking to anything, and the logs affordance stays
 * in the rail below.
 *
 * **Below `sm` the tabs and the pill's label go into the menu drawer.** Four
 * tabs and the pill overflowed a 390px header, so the phone header is the
 * menu button, the wordmark, and the pill reduced to its dot (title and
 * accessible label kept); the drawer's first line is the full label. From `sm`
 * up every `sm:`-gated class renders exactly what it did before.
 */
export function TopNav() {
  const pathname = usePathname();
  const { pillLabel, pillTone, pulsing } = useSystemHealth();

  const envChrome = IS_NON_PROD
    ? "border-t-2 border-t-[var(--amber-border)] shadow-[0_2px_18px_-6px_var(--amber-glow)]"
    : "";

  const healthDot = <PulseDot active={pulsing} color={TONE_TO_DOT[pillTone]} label={pillLabel} />;
  const healthText = (
    <span className={`text-[11px] font-medium ${TONE_TO_TEXT[pillTone]}`}>{pillLabel}</span>
  );

  return (
    <header
      className={`sticky top-0 z-30 h-12 sm:h-16 bg-[var(--sidebar)]/90 backdrop-blur-[12px] border-b border-[var(--sidebar-border)] ${envChrome}`}
    >
      <div className="h-full max-w-[1200px] mx-auto px-4 sm:px-6 flex items-center gap-3 sm:gap-8">
        {/* The lockup is the same on every breakpoint, 36px tile on a phone
            and 40px from `sm`; `Crossfire` is short enough that nothing has
            to come off it. */}
        <div className="sm:hidden shrink-0">
          <TopNavDrawer
            items={navItems}
            pathname={pathname}
            status={
              <>
                {healthDot}
                {healthText}
              </>
            }
          />
        </div>

        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <Lockup />
        </Link>

        <nav className="hidden sm:flex items-center gap-0.5 sm:gap-1 flex-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`px-2 sm:px-3 py-1 sm:py-1.5 rounded-md text-[13px] sm:text-sm transition-colors ${
                isNavItemActive(item, pathname) ? NAV_ACTIVE : NAV_IDLE
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* `ml-auto` does nothing from `sm` up, where the nav's `flex-1`
            already takes the slack; on a phone it pushes this cluster right. */}
        <div className="ml-auto flex items-center gap-2 sm:gap-4 shrink-0">
          <div className="hidden sm:flex items-center gap-4">
            <NotificationsToggle />
            <div className="h-5 w-px bg-[var(--card-border)]" />
          </div>
          <div className="sm:hidden flex items-center" title={pillLabel}>
            {healthDot}
          </div>
          <div
            className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-full bg-[var(--hover)] border border-[var(--card-border)]"
            title={pillLabel}
          >
            {healthDot}
            {healthText}
          </div>
        </div>
      </div>
    </header>
  );
}
