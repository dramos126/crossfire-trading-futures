"use client";

import { useState } from "react";
import { InsetSourceBadge } from "@/components/settings/settings-connection-controls";
import { parseSettingsBundle, type SettingsBundle } from "@/lib/settings/parse-bundle";

/**
 * Notifications — the Discord webhook and the kill-switch. The Settings
 * Notifications page renders it; the file keeps the name of the section it
 * was written for.
 *
 * The toggle here and the one in `TopNav` are the same control: both read and
 * write `app_settings.notifications_enabled` through `/api/settings`, which is
 * why the nav's copy can be dropped on a phone without losing a capability.
 */

const INPUT_CLASS =
  "w-full min-h-11 sm:min-h-0 border border-[var(--card-border)] bg-[var(--bg)] px-3 pr-14 py-2 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)] rounded-md transition-colors";

export function SettingsGeneralBlock({
  bundle,
  token,
  onSaved,
}: {
  bundle: SettingsBundle;
  token: string;
  onSaved: (updated: SettingsBundle) => void;
}) {
  const [webhookInput, setWebhookInput] = useState("");
  const [notifications, setNotifications] = useState(bundle.notificationsEnabled);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const webhookPlaceholder =
    bundle.webhookUrlSource === "unset"
      ? "https://discord.com/api/webhooks/…"
      : bundle.topstepWebhookUrlPreview
        ? `${bundle.topstepWebhookUrlPreview} — leave blank to keep`
        : "•••••• — leave blank to keep";

  const dirty =
    webhookInput.trim().length > 0 || notifications !== bundle.notificationsEnabled;

  const clientValidationError = (() => {
    const trimmed = webhookInput.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("https://")) {
      return "Webhook URL must start with https://";
    }
    return null;
  })();

  async function save() {
    if (!token) return;
    if (clientValidationError) {
      setSaveError(clientValidationError);
      return;
    }
    const body: Record<string, unknown> = {};
    const trimmed = webhookInput.trim();
    if (trimmed.length > 0) body.topstepWebhookUrl = trimmed;
    if (notifications !== bundle.notificationsEnabled) body.notificationsEnabled = notifications;
    if (Object.keys(body).length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        setSaveError((data as { error?: string }).error ?? `Save failed (${res.status})`);
        return;
      }
      const parsed = parseSettingsBundle(data);
      if ("error" in parsed) {
        setSaveError(`Bundle validation failed: ${parsed.error}`);
        return;
      }
      setWebhookInput("");
      setSavedAt(Date.now());
      onSaved(parsed);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    // Untitled: the page's section header already says Notifications.
    <section className="border border-[var(--card-border)] bg-[var(--card)] p-4 space-y-4">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label
            htmlFor="settings-webhook-url"
            className="block text-xs font-medium text-[var(--muted)] uppercase tracking-wider"
          >
            Discord Webhook URL
          </label>
          <div className="relative">
            <input
              id="settings-webhook-url"
              type="text"
              value={webhookInput}
              onChange={(e) => {
                setWebhookInput(e.target.value);
                setSavedAt(null);
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder={webhookPlaceholder}
              className={INPUT_CLASS}
            />
            <InsetSourceBadge source={bundle.webhookUrlSource} />
          </div>
        </div>

        <div className="flex items-end pb-1">
          <button
            type="button"
            role="switch"
            aria-checked={notifications}
            aria-label="Enable notifications"
            onClick={() => {
              setNotifications((v) => !v);
              setSavedAt(null);
            }}
            className="flex items-center gap-3 group"
          >
            <span
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors ${
                notifications
                  ? "bg-[var(--success)]/15 border-[var(--success)]/60"
                  : "bg-[var(--bg)] border-[var(--card-border)]"
              }`}
            >
              <span
                className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
                  notifications
                    ? "left-[18px] bg-[var(--success)]"
                    : "left-0.5 bg-[var(--muted-secondary)]"
                }`}
              />
            </span>
            <span className="text-sm text-[var(--foreground)]">Enable notifications</span>
          </button>
        </div>
      </div>

      {(saveError ?? clientValidationError) && (
        <div className="border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2.5 text-sm font-mono text-[var(--danger)] rounded-md">
          {saveError ?? clientValidationError}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {savedAt && !dirty && !saveError && (
          <span className="font-mono text-[10px] px-2 py-0.5 border border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)] rounded-sm">
            SAVED
          </span>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty || !!clientValidationError}
          className="btn-emerald px-5 py-2 rounded-md text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}
