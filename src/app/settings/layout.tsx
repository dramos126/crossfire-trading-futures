"use client";

import { AppChrome } from "@/components/app-chrome";
import { SettingsWorkbench } from "@/components/settings/settings-workbench";

/**
 * Every `/settings/*` page, and the state a first run lives in now that
 * `/setup` is deleted.
 *
 * **`AppChrome`, not `AppShell`, and that is the whole reason the split
 * exists.** `<SetupGuard>` redirects an unconfirmed install to `/settings`;
 * wrapping these pages in the guard would redirect them to themselves
 * forever. The invariant is *the page the guard redirects to is never wrapped
 * by the guard*, and it is kept structurally — by composing the chrome
 * without the guard here, once, for every sub-page — rather than by a path
 * allowlist inside the guard, which would rot the first time a route is
 * renamed. A new Settings page added under this directory inherits it.
 *
 * **The workbench lives here rather than in each page** so its state — typed
 * credentials, test results, the first-run webhook — survives moving between
 * pages; a layout is not remounted by navigation between its children.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppChrome>
      <SettingsWorkbench>{children}</SettingsWorkbench>
    </AppChrome>
  );
}
