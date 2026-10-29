/**
 * `StrategyConfig.intent` is operator guidance for the picker's badge and is
 * never read by a gate, filter or deploy check — see the field's doc comment.
 * It reaches an account class in exactly one place, `seedArmedPlaybooks`, and
 * that is a one-time seed of an editable default rather than a check; the
 * allowlist below carries the distinction. Two kinds of test hold that up, the same
 * split [logging/exit-reasons.test.ts](../logging/exit-reasons.test.ts) uses
 * for its own completeness scan.
 *
 * The first is ordinary: `INTENT_LABELS` is pinned as values, because it is
 * the one wording every badge surface renders from.
 *
 * The second is the completeness scan. It enumerates every read of the field
 * from source rather than sampling the surfaces a brief named, so a *new*
 * reader — a gate, a filter, a sizer — is caught the moment it is written
 * rather than at review. This file imports only `strategy-types.ts`, which
 * imports nothing from `strategies/`, so the scan can never fail at
 * collection on a module graph it does not care about.
 *
 * The same scan runs over `config.calibration` and `config.admission`, which
 * are declarations a display surface reads and nothing else. All three fields
 * are display-only, so each is a version bump and a CHANGELOG entry cheaper
 * than a real behaviour change — and each is one careless read away from
 * being neither.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect, expectTypeOf } from "vitest";
import { INTENT_LABELS, type EntrySignal } from "./strategy-types";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const SOURCES = sourceFiles(path.join(REPO_ROOT, "src")).map((file) => ({
  file: path.relative(REPO_ROOT, file).replace(/\\/g, "/"),
  text: readFileSync(file, "utf8"),
}));

/**
 * Every file allowed to mention `config.intent` — the label map's own
 * declaration, the listing/board adapters that carry the field from a
 * module onto a row, and the display surfaces that read it off that row to
 * pass to `IntentBadges`. No gate, filter, sizer, deploy route or
 * account-type comparison belongs on this list; that is the whole guarantee
 * the field's doc comment makes.
 */
const ALLOWED_INTENT_READERS = [
  "src/lib/trading/strategy-types.ts",
  // No non-display reader is left: `seedArmedPlaybooks`, the one-time seed
  // that paired the label with the account's class at book creation, retired
  // with shared books (book types step 2) — a book is picked, not seeded. A
  // reader anywhere in the books path is the label becoming the gate the
  // operator's 2026-09-11 ruling forbids.
  "src/components/intent-badges.tsx",
  "src/components/deployment/deployment-editor.tsx",
  "src/components/board/board-model.ts",
  "src/components/board/use-board.ts",
  // The Playbooks page. Its model carries the field onto a header the list
  // row and the detail title share; both hand it to `IntentBadges` and
  // neither branches on it.
  "src/components/playbook/playbook-detail-model.ts",
  // The book grid. `book-grid.tsx` copies the label verbatim into a cell's
  // facts and `book-grid-model.ts` names the shelf in an off cell's tooltip.
  // The seed that arms a cell is `books/seed.ts` above; the grid enforces
  // nothing.
  "src/components/book/book-grid.tsx",
  "src/components/book/book-grid-model.ts",
];

/**
 * `config.calibration` and `config.admission` sit on the same footing and get
 * the same scan: a playbook's constants and its admission entry are read by
 * the read-only Playbooks page and by nothing else. The declaring module does
 * not appear here — it writes `calibration:` / `admission:` inside a config
 * literal and never spells the dotted form — so a file on this list is a
 * *reader*, and a reader that is not a display surface is the defect.
 */
const ALLOWED_CALIBRATION_READERS = [
  "src/lib/trading/strategy-types.ts",
  // The Playbooks page's *Constants* frame — the one renderer. It reaches
  // `config.calibration` to draw rows and nothing else; no gate, filter,
  // sizer or deploy check is downstream of it.
  "src/components/playbook/playbook-detail.tsx",
];
const ALLOWED_ADMISSION_READERS = [
  "src/lib/trading/strategy-types.ts",
  // The Playbooks page's *Admission* and *Runs* frames, and the stamp beside
  // a row's name. Display only: `status: "retired"` refuses nothing here, and
  // the list's admitted/not-admitted filter is a view over rows the operator
  // chose, not a rule about what may trade.
  "src/components/playbook/playbook-detail.tsx",
  "src/components/playbook/playbook-detail-model.ts",
];

/**
 * `config.fixedStopTicks` is the same footing again: the stop a playbook's
 * defaults place, declared so a display can price the smallest risk per trade
 * that takes one contract. The sizer reads the hook's `slTicks`, never this.
 */
const ALLOWED_FIXED_STOP_READERS = [
  "src/lib/trading/strategy-types.ts",
  // The one pricer: the Playbooks page and the book grid render its answer.
  "src/components/playbook/playbook-minimum-risk.ts",
];

describe("INTENT_LABELS", () => {
  it("is the one wording for each admission shelf", () => {
    expect(INTENT_LABELS.growth).toBe("Cash · growth");
    expect(INTENT_LABELS.speed).toBe("Combine · speed");
  });
});

function pinReaderSet(field: string, what: string, allowed: readonly string[]): void {
  const mentions = new RegExp(`\\bconfig\\??\\.${field}\\b`);

  describe(`config.${field} stays ${what}, never a gate`, () => {
    it("is mentioned only by the declared carrier/display surfaces", () => {
      const offenders = SOURCES.filter(
        ({ file, text }) => mentions.test(text) && !allowed.includes(file),
      ).map(({ file }) => file);
      expect(offenders).toEqual([]);
    });

    it("every allowed reader still exists and still mentions it", () => {
      // The other half of the scan: a file removed from the surface set
      // without being removed from this list would let the guarantee above
      // pass vacuously.
      for (const file of allowed) {
        const entry = SOURCES.find((s) => s.file === file);
        expect(entry, `${file} is missing from the source tree`).toBeDefined();
        expect(mentions.test(entry!.text), `${file} no longer mentions config.${field}`).toBe(true);
      }
    });
  });
}

pinReaderSet("intent", "guidance", ALLOWED_INTENT_READERS);
pinReaderSet("calibration", "a declaration", ALLOWED_CALIBRATION_READERS);
pinReaderSet("admission", "a declaration", ALLOWED_ADMISSION_READERS);
pinReaderSet("fixedStopTicks", "a declaration", ALLOWED_FIXED_STOP_READERS);

// Every path fills an entry at market — the backtest at the signal bar's close,
// the engine with no price on the order — so a resting-entry price on the
// contract would read as a capability nothing implements. Checked by tsc.
describe("A66 — EntrySignal carries no resting-entry price", () => {
  it("declares neither limitPrice nor stopPrice", () => {
    expectTypeOf<EntrySignal>().not.toHaveProperty("limitPrice");
    expectTypeOf<EntrySignal>().not.toHaveProperty("stopPrice");
  });
});
