"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SettingsPageEntry } from "@/components/settings/settings-model";

/**
 * The Settings page's left menu. The entry treatment is `TopNav`'s, turned on
 * its side — a second nav idiom for one page is what the design language
 * forbids inventing.
 *
 * A column from `sm` up; below it the same entries sit in one row above the
 * page that scrolls sideways rather than wrapping, because a 160px column on a
 * phone leaves the form no width at all and a wrapped menu takes two lines.
 */
export function SettingsNav({ pages }: { pages: readonly SettingsPageEntry[] }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Settings"
      className="flex min-w-0 flex-row flex-nowrap gap-1 overflow-x-auto sm:min-w-auto sm:flex-col sm:flex-wrap sm:overflow-x-visible"
    >
      {pages.map((page) => {
        const current = pathname === page.href;
        return (
          <Link
            key={page.id}
            href={page.href}
            aria-current={current ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-md text-[13px] sm:shrink sm:whitespace-normal sm:text-sm transition-colors ${
              current
                ? "bg-[var(--active-ui-bg)] text-[var(--foreground)] font-medium"
                : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--hover)]"
            }`}
          >
            {page.label}
          </Link>
        );
      })}
    </nav>
  );
}
