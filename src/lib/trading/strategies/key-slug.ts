/**
 * The key a playbook's display name gives: lowercase ASCII, every run of
 * anything else (spaces, em-dashes, parentheses) one `-`, none leading or
 * trailing. `"Bar Close Pulse (5m) — MNQ"` → `"bar-close-pulse-5m-mnq"`.
 *
 * A production key equals the slug of its `config.name` (strategies.md,
 * Decisions 2026-10-16), so the name the operator reads and the key a row
 * stores cannot name two different playbooks.
 */
export function slugOfName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
