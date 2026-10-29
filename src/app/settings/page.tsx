import { redirect } from "next/navigation";
import { SETTINGS_LANDING_HREF } from "@/components/settings/settings-model";

/**
 * `/settings` lands on Connections. It stays a route because `<SetupGuard>`
 * redirects here and so do the top nav and the post-reset navigation; none
 * of them needs to know which page is first.
 */
export default function SettingsIndex(): never {
  redirect(SETTINGS_LANDING_HREF);
}
