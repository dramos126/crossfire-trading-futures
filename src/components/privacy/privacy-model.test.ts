import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountAliases,
  maskAccountName,
  maskText,
  maskUsdFigures,
  MASKED_USD,
  UNKNOWN_ACCOUNT_ALIAS,
} from "./privacy-model";

/** Real Topstep practice names, per the prefix table in docs/modules/brokers/topstep.md. */
const PRAC_A = { id: 5001, name: "PRAC-V2-100200-90012114", practice: true };
const PRAC_B = { id: 5002, name: "PRAC-V2-100200-90020038", practice: true };
const COMBINE = { id: 4020, name: "50KTC-V2-100200-11223344", practice: false };
const CATALOGUE = [PRAC_B, COMBINE, PRAC_A];

describe("accountAliases", () => {
  it("numbers by ascending id", () => {
    const a = accountAliases(CATALOGUE);
    expect(maskAccountName(COMBINE.name, a, true)).toBe("Account 1");
    expect(maskAccountName(PRAC_A.name, a, true)).toBe("Account 2");
    expect(maskAccountName(PRAC_B.name, a, true)).toBe("Account 3");
  });

  it("is stable under input order", () => {
    const forward = accountAliases(CATALOGUE);
    const reversed = accountAliases([...CATALOGUE].reverse());
    for (const acct of CATALOGUE) {
      expect(maskAccountName(acct.name, reversed, true)).toBe(maskAccountName(acct.name, forward, true));
    }
  });

  it("numbers the full catalogue, so a practice-filtered subset keeps each account's number", () => {
    const full = accountAliases(CATALOGUE);
    const visible = CATALOGUE.filter((a) => a.practice);
    for (const acct of visible) expect(maskAccountName(acct.name, full, true)).not.toBe("Account 1");
    // Numbering the subset instead would renumber PRAC_A from 2 to 1 when the filter flips.
    expect(maskAccountName(PRAC_A.name, accountAliases(visible), true)).toBe("Account 1");
    expect(maskAccountName(PRAC_A.name, full, true)).toBe("Account 2");
  });

  it("resolves by name and by numeric id", () => {
    const a = accountAliases(CATALOGUE);
    expect(maskAccountName(String(PRAC_A.id), a, true)).toBe("Account 2");
    expect(maskAccountName(PRAC_A.name, a, true)).toBe("Account 2");
  });
});

describe("maskAccountName", () => {
  const a = accountAliases(CATALOGUE);

  it("answers Account ? for an unknown account when on, never the raw name", () => {
    expect(maskAccountName("PRAC-V2-000000-00000000", a, true)).toBe(UNKNOWN_ACCOUNT_ALIAS);
    expect(maskAccountName("Account 9999", a, true)).toBe(UNKNOWN_ACCOUNT_ALIAS);
    expect(maskAccountName(null, a, true)).toBe(UNKNOWN_ACCOUNT_ALIAS);
  });

  it("is unchanged when off, known or not", () => {
    expect(maskAccountName(PRAC_A.name, a, false)).toBe(PRAC_A.name);
    expect(maskAccountName("PRAC-V2-000000-00000000", a, false)).toBe("PRAC-V2-000000-00000000");
  });
});

describe("maskText", () => {
  it("replaces a longer name before a shorter one that is its prefix", () => {
    const a = accountAliases([
      { id: 1, name: "PRAC-V2-100200" },
      { id: 2, name: "PRAC-V2-100200-90012114" },
    ]);
    expect(maskText("entry on PRAC-V2-100200-90012114 filled", a, true)).toBe("entry on Account 2 filled");
    expect(maskText("entry on PRAC-V2-100200 filled", a, true)).toBe("entry on Account 1 filled");
  });

  it("replaces a whole-token id but not a digit run inside a price", () => {
    const a = accountAliases([{ id: 21345, name: "PRAC-V2-100200-90012114" }]);
    expect(maskText("account 21345 skipped", a, true)).toBe("account Account 1 skipped");
    expect(maskText("acct 21345.", a, true)).toBe("acct Account 1.");
    expect(maskText("stop at 21345.25", a, true)).toBe("stop at 21345.25");
    expect(maskText("balance $21,345.00", a, true)).toBe("balance $21,345.00");
    expect(maskText("contract 213456", a, true)).toBe("contract 213456");
  });

  it("resolves the log pipe's …last4 rendering of an id, unless two accounts share the tail", () => {
    const a = accountAliases([
      { id: 12344469, name: "PRAC-V2-100200-90012114" },
      { id: 5002, name: "PRAC-V2-100200-90020038" },
    ]);
    expect(maskText("…4469-ema-crossover.MNQ skipped", a, true)).toBe("Account 2-ema-crossover.MNQ skipped");
    expect(maskAccountName("…4469", a, true)).toBe("Account 2");
    const shared = accountAliases([
      { id: 14469, name: "PRAC-V2-100200-90012114" },
      { id: 24469, name: "PRAC-V2-100200-90020038" },
    ]);
    expect(maskText("…4469 skipped", shared, true)).toBe("…4469 skipped");
  });

  it("does not re-scan an alias it wrote for an id, and masking twice changes nothing", () => {
    const a = accountAliases([{ id: 1, name: "PRAC-V2-100200-90012114" }]);
    const once = maskText("PRAC-V2-100200-90012114 and 1", a, true);
    expect(once).toBe("Account 1 and Account 1");
    expect(maskText(once, a, true)).toBe(once);
  });

  it("is unchanged when off", () => {
    const a = accountAliases(CATALOGUE);
    expect(maskText(`flatten on ${PRAC_A.name}`, a, false)).toBe(`flatten on ${PRAC_A.name}`);
  });
});

describe("maskUsdFigures", () => {
  it("masks every $ figure when on — which is why it only ever sees balance sentences", () => {
    expect(maskUsdFigures("balance $1,234.56 over a $50,576.16 floor", true)).toBe(
      `balance ${MASKED_USD} over a ${MASKED_USD} floor`,
    );
    expect(maskUsdFigures("lost -$58.48", true)).toBe(`lost ${MASKED_USD}`);
    // A comma after the figure is punctuation, not a thousands group.
    expect(maskUsdFigures("closed at $50,750, at or below its $49,000 floor", true)).toBe(
      `closed at ${MASKED_USD}, at or below its ${MASKED_USD} floor`,
    );
    expect(maskUsdFigures("balance $1,234.56", false)).toBe("balance $1,234.56");
  });

  it("is called only from the files that pass it balance-derived sentences", () => {
    // A P&L string passed to it would be masked, and P&L is never hidden; so
    // every call site is named here and a new one fails until it is reviewed.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const calls = /\bmaskUsdFigures\s*\(/;
    const definition = /function\s+maskUsdFigures\s*\(/;
    const scanned: string[] = [];
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          scanned.push(full);
          const lines = readFileSync(full, "utf8").split("\n");
          if (lines.some((l) => calls.test(l) && !definition.test(l))) {
            callers.push(path.relative(root, full).split(path.sep).join("/"));
          }
        }
      }
    };
    walk(root);

    expect(calls.test("x = maskUsdFigures (detail, on)")).toBe(true);
    expect(scanned.length).toBeGreaterThan(50);
    expect(callers.sort()).toEqual([
      "account/account-risk-block.tsx",
      "board/board-card.tsx",
      "board/board-view.ts",
      "book/book-account-card.tsx",
    ]);
  });
});
