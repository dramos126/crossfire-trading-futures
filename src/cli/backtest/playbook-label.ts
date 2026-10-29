/**
 * How the CLI's human-facing output names a playbook: by the module's
 * `config.name`, the name the app shows, never by its key. Keys stay in JSON
 * fields and directory names, which are joined on, not read.
 *
 * Resolved at runtime from the loaded registry, keyed by whatever key the
 * record carries — nothing about a name is written into the record. A key
 * with no loaded module (an old run, a module since renamed or removed)
 * reads as itself.
 */
import { RENAMED_KEYS } from "@/lib/trading/strategies/renamed-keys";
import type { StrategyModule } from "@/lib/trading/strategy-types";

/** Strategy key → `config.name`. */
export type PlaybookNames = ReadonlyMap<string, string>;

/**
 * A record written under a key since renamed (a parity day before 2026-10-16)
 * names the same playbook, so an old key maps to its new key's name. The key
 * itself is never rewritten here — the row keeps what it carried.
 */
export function playbookNames(
  strategies: Readonly<Record<string, { config: Pick<StrategyModule["config"], "name"> }>>,
): PlaybookNames {
  const names = new Map(Object.entries(strategies).map(([key, mod]) => [key, mod.config.name]));
  for (const [oldKey, newKey] of Object.entries(RENAMED_KEYS)) {
    const name = names.get(newKey);
    if (name !== undefined && !names.has(oldKey)) names.set(oldKey, name);
  }
  return names;
}

function bareTicker(ticker: string): string {
  return ticker.replace(/^\//, "");
}

function carriesInstrument(name: string, ticker: string): boolean {
  const escaped = ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(name);
}

/** `Opening Range Close Break — MES`: the display name, with ` — <ticker>`
 *  appended when the name does not already carry the leg's instrument. */
export function playbookDisplayName(names: PlaybookNames, key: string, ticker: string): string {
  const name = names.get(key) ?? key;
  const instrument = bareTicker(ticker);
  if (instrument.length === 0 || carriesInstrument(name, instrument)) return name;
  return `${name} — ${instrument}`;
}

/** `Opening Range Close Break — MES (deployment …1942)`, or with
 *  `, account …9820` inside the parenthesis where no heading names the account. */
export function playbookLabel(
  names: PlaybookNames,
  leg: { strategyKey: string; ticker: string; deploymentId: string },
  accountId: number | null = null,
): string {
  const account = accountId == null ? "" : `, account …${String(accountId).slice(-4)}`;
  return `${playbookDisplayName(names, leg.strategyKey, leg.ticker)} (deployment …${leg.deploymentId.slice(-4)}${account})`;
}
