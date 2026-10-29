/**
 * The exit-reason table is a contract three surfaces render from — the chip,
 * the Discord embed and (in L4) the Activity lane — and one surface *matches*
 * on: the relabel sweep's SQL. Two kinds of test hold it up.
 *
 * The first is ordinary: labels are pinned as values so a wording change has
 * to change a test, and the Activity phrasings get the mechanical half of the
 * phone test that `vocabulary.test.ts` already applies to event templates.
 *
 * The second is the completeness scan. **It enumerates the submission sites
 * from source rather than sampling them**, because the failure this table
 * exists to prevent is a *new* actor submitting a reason nobody added an
 * entry for — which no import-based test can see. `"Flatten All"` was exactly
 * that: a label written into the code slot, unrecognised by every arm, so
 * every panic-button close was relabelled to the residual reason and swept
 * forever.
 *
 * This file imports only `exit-reasons.ts`, which imports nothing, so the
 * scan can never fail at collection on a module graph it does not care about.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  EXIT_REASONS,
  EXIT_REASON_BRACKET_MANUAL,
  exitReasonActivity,
  exitReasonCodeForLabel,
  exitReasonCodeOf,
  exitReasonLabel,
  isExitReasonCode,
  resolveExitReason,
  type ExitReasonCode,
} from "./exit-reasons";

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

/** `const NAME: ExitReasonCode = "literal"` / `const NAME = "literal"`. */
function resolveConstant(name: string): string | null {
  const re = new RegExp(`const\\s+${name}(?::\\s*[A-Za-z<>|\\s]+)?\\s*=\\s*"([^"]+)"`);
  for (const { text } of SOURCES) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

/**
 * The reason expression at every site that can put a value into
 * `strategy_trades.exit_reason_code`.
 *
 * Two shapes reach the column and no third one does: `attachPendingExit`
 * writes it, and `placeExitOrder`'s seventh argument is what it writes.
 */
function submissionSites(): Array<{ file: string; expr: string }> {
  const found: Array<{ file: string; expr: string }> = [];
  for (const { file, text } of SOURCES) {
    // `placeExitOrder(a, b, c, d, e, f, REASON)` — multi-line at every call
    // site in the tree, so match to the closing paren and take the last
    // argument.
    const callRe = /placeExitOrder\(\s*([\s\S]*?)\s*\)\s*[;,)]/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(text)) !== null) {
      const args = m[1].split(",").map((a) => a.trim()).filter((a) => a.length > 0);
      if (args.length < 6) continue;
      // A *declaration*'s parameters carry type annotations and a call's
      // arguments do not, which is the cheapest way to tell the four
      // `*Deps` signatures and the exported function apart from the seven
      // real call sites.
      if (args.some((a) => a.includes(":"))) continue;
      // The reason is the last argument, except at the one site that also
      // declares an `ExitIntent` after it. Two arities are in play — the
      // module function takes `deps` first and the engine's method does
      // not — so dropping a trailing intent is more robust than indexing.
      const last = args[args.length - 1];
      const isIntent = last === '"engine_exit"' || last === '"unmanaged_position"';
      found.push({ file, expr: isIntent ? args[args.length - 2] : last });
    }
    const attachRe = /attachPendingExit\(\{[\s\S]*?exitReason:\s*([^,\n]+)/g;
    while ((m = attachRe.exec(text)) !== null) {
      found.push({ file, expr: m[1].trim() });
    }
  }
  return found;
}

/**
 * Expressions the scan cannot reduce to a literal, each with the reason it
 * is safe and the assertion that covers it below. **Adding to this list is
 * the wrong move for a new constant** — type the constant `ExitReasonCode`
 * and the scan resolves it.
 */
const NON_LITERAL_SUBMISSIONS: Readonly<Record<string, string>> = {
  // `placeExitOrder`'s own parameter, and the four guard shims that forward
  // it. Pass-throughs, not sources.
  reason: "a forwarded parameter — the value comes from one of the sites below",
  // engine.ts's strategy arm: `strategy_signal`, `strategy_signal:<detail>`,
  // or an exit-filter key. Asserted by name in its own test.
  engineReason: "strategy_signal, strategy_signal:<detail>, or an exit-filter key",
};

describe("the exit-reason table", () => {
  it("names every code in snake_case", () => {
    for (const code of Object.keys(EXIT_REASONS)) {
      expect(code, code).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });

  it("gives every code a non-empty label and Activity phrasing", () => {
    for (const [code, spec] of Object.entries(EXIT_REASONS)) {
      expect(spec.label.length, code).toBeGreaterThan(0);
      expect(spec.activity.length, code).toBeGreaterThan(0);
    }
  });

  // The labels are the strings an operator actually reads, and until L2
  // nothing failed when one drifted — the SQL matched one of them and the
  // chip switch matched the rest. Pinned as values for that reason.
  it.each<[ExitReasonCode, string]>([
    ["take_profit", "Take Profit"],
    ["stop_loss", "Stop Loss"],
    ["breakeven_stop", "Breakeven Stop"],
    ["trail_stop", "Trail Stop"],
    ["strategy_signal", "Strategy Exit"],
    ["realtime_exit", "Strategy Exit"],
    ["time_stop", "Strategy Exit · Time Stop"],
    ["ema_exit", "Strategy Exit · EMA Close-Through"],
    ["time_window_close", "Time Window Close"],
    ["deployment_close", "Deployment Close"],
    ["bracket_failure_force_close", "Force Close (bracket failure)"],
    ["engine_downtime", "Engine Downtime"],
    ["manual_position_close", "Hand Position Close"],
    ["flatten_all", "Flatten All"],
    ["flatten_deployment", "Flatten Deployment"],
    ["manual", "Manual"],
    ["bracket_manual", "Bracket/Manual"],
  ])("renders %s as %s", (code, expected) => {
    expect(exitReasonLabel(code)).toBe(expected);
  });

  // The mechanical half of the phone test, same rules `vocabulary.test.ts`
  // applies to event templates: an Activity phrasing is read aloud by
  // someone who does not understand it, so it may not carry an internal
  // identifier or a shorthand nobody outside this repo can expand.
  describe("the phone test", () => {
    it("leaks no snake_case identifier into any Activity phrasing", () => {
      for (const [code, spec] of Object.entries(EXIT_REASONS)) {
        expect(spec.activity, code).not.toMatch(/\b[a-z]+(_[a-z0-9]+)+\b/);
      }
    });

    it("carries no internal shorthand in any Activity phrasing", () => {
      for (const [code, spec] of Object.entries(EXIT_REASONS)) {
        expect(spec.activity, code).not.toMatch(/\b[A-Z]{1,2}-\d+\b/);
      }
    });

    it("reads as a sentence fragment that completes the exit template", () => {
      // The Activity template is "Closed {ticker} {pnl} — {reason}", so a
      // phrasing that starts with a capital or ends with a full stop reads
      // as a second sentence spliced onto the first.
      for (const [code, spec] of Object.entries(EXIT_REASONS)) {
        if (code === "flatten_all") continue; // "Flatten All" is a control's name
        expect(spec.activity[0], code).toBe(spec.activity[0].toLowerCase());
        expect(spec.activity.endsWith("."), code).toBe(false);
      }
    });
  });
});

describe("resolving a stored reason", () => {
  it("reads a bare code", () => {
    expect(resolveExitReason("deployment_close")).toEqual({
      code: "deployment_close",
      detail: null,
      label: "Deployment Close",
    });
  });

  it("splits the detail off the two codes that carry strategy prose", () => {
    expect(resolveExitReason("strategy_signal:EMA close-through")).toEqual({
      code: "strategy_signal",
      detail: "EMA close-through",
      label: "Strategy Exit · EMA close-through",
    });
    expect(resolveExitReason("realtime_exit:MACD Cross").label).toBe("Strategy Exit · MACD Cross");
  });

  it("drops the separator when the detail is empty", () => {
    expect(resolveExitReason("strategy_signal:").label).toBe("Strategy Exit");
    expect(resolveExitReason("strategy_signal:").detail).toBeNull();
  });

  it("refuses a colon suffix on a code that does not carry one", () => {
    // `time_window_close:whatever` is not a reason anything submits, and
    // silently accepting it would invent a detail the actor never named.
    expect(resolveExitReason("time_window_close:whatever").code).toBe(EXIT_REASON_BRACKET_MANUAL);
  });

  it.each([null, undefined, "", "something_the_engine_never_emits"])(
    "falls to the residual reason for %j",
    (raw) => {
      expect(resolveExitReason(raw).code).toBe(EXIT_REASON_BRACKET_MANUAL);
    },
  );

  it("tells a residual reason apart from a row that has none", () => {
    expect(exitReasonCodeOf("bracket_manual")).toBe(EXIT_REASON_BRACKET_MANUAL);
    expect(exitReasonCodeOf(null)).toBeNull();
    expect(exitReasonCodeOf("Bracket/Manual")).toBeNull();
  });
});

describe("the legacy label backfill", () => {
  it("maps every label back to a code", () => {
    for (const [code, spec] of Object.entries(EXIT_REASONS)) {
      const back = exitReasonCodeForLabel(spec.label);
      expect(back, code).not.toBeNull();
      expect(EXIT_REASONS[back!].label, code).toBe(spec.label);
    }
  });

  it("maps a strategy-detail label by its prefix", () => {
    expect(exitReasonCodeForLabel("Strategy Exit · EMA close-through")).toBe("strategy_signal");
  });

  it("answers null for a label that predates the table", () => {
    expect(exitReasonCodeForLabel("Some Old Wording")).toBeNull();
    expect(exitReasonCodeForLabel(null)).toBeNull();
  });
});

describe("completeness — every submission site maps to a table entry", () => {
  const sites = submissionSites();

  it("finds the submission sites at all", () => {
    // The scan is regex over source, so a refactor that renames the two
    // functions would silently find nothing and pass everything. This is
    // the assertion that makes the scan's own failure visible.
    expect(sites.length).toBeGreaterThanOrEqual(9);
    const files = new Set(sites.map((s) => s.file));
    expect(files).toContain("src/lib/trading/engine/session-close/engine-closing.ts");
    expect(files).toContain("src/lib/trading/engine/engine-exit.ts");
    expect(files).toContain("src/lib/trading/engine/flatten/engine-force-flat.ts");
    expect(files).toContain("src/lib/trading/engine/flatten/engine-manual-position.ts");
    expect(files).toContain("src/lib/trading/engine/boot/engine-restart.ts");
    expect(files).toContain("src/lib/trading/engine/session-close/engine-session-guard.ts");
    expect(files).toContain("src/lib/trading/engine/engine.ts");
    expect(files).toContain("src/app/api/deployments/flatten-all/route.ts");
  });

  it("resolves every site's reason to a code the table carries", () => {
    const unmapped: string[] = [];
    for (const { file, expr } of sites) {
      if (expr in NON_LITERAL_SUBMISSIONS) continue;
      const literal = expr.startsWith('"')
        ? expr.replace(/"/g, "")
        : resolveConstant(expr);
      if (literal == null || exitReasonCodeOf(literal) == null) {
        unmapped.push(`${file}: ${expr}${literal == null ? "" : ` → "${literal}"`}`);
      }
    }
    // A failure here means a new actor submits a reason with no label, no
    // Activity phrasing and no chip — the row lands on the residual arm and
    // the relabel sweep retries it forever. Add the code to EXIT_REASONS.
    expect(unmapped).toEqual([]);
  });

  it("covers the strategy arm's three shapes, which no constant carries", () => {
    // engine.ts builds `engineReason` as an exit-filter key, or
    // `strategy_signal`, or `strategy_signal:<detail>`.
    expect(exitReasonCodeOf("strategy_signal")).toBe("strategy_signal");
    expect(exitReasonCodeOf("strategy_signal:EMA close-through")).toBe("strategy_signal");
    expect(exitReasonCodeOf("realtime_exit")).toBe("realtime_exit");
  });

  it("carries a code for every exit filter that can return an exit", () => {
    // `anyExitFilterTriggered` returns `filter.key as ExitReason`, and the
    // engine forwards that key straight to `placeExitOrder` — so a filter
    // whose trigger can answer `{ type: "exit" }` needs a table entry. The
    // registry's other two entries only ever answer `modifySl`, which is a
    // bracket move and not an exit at all.
    const registry = SOURCES.find((s) => s.file === "src/lib/trading/filters/index.ts");
    expect(registry).toBeDefined();
    // Bounded to the literal's own closing brace: everything after it is
    // ordinary module code and several helpers there mention `type: "exit"`,
    // which would read as the last entry being exit-capable.
    const start = registry!.text.indexOf("export const EXIT_FILTER_REGISTRY");
    const body = registry!.text.slice(start, registry!.text.indexOf("\n};", start));
    const entries = body.split(/\n {4}(?=[a-z_]+:\s*\{)/);
    const exitCapable: string[] = [];
    const modifyOnly: string[] = [];
    for (const entry of entries) {
      const key = /key:\s*"([a-z_]+)"/.exec(entry)?.[1];
      if (key == null) continue;
      (entry.includes('type: "exit"') ? exitCapable : modifyOnly).push(key);
    }
    expect(exitCapable.length).toBeGreaterThan(0);
    for (const key of exitCapable) {
      expect(isExitReasonCode(key), `exit filter "${key}" has no exit-reason entry`).toBe(true);
    }
    expect(modifyOnly.sort()).toEqual(["breakeven", "trail"]);
  });
});

describe("the Activity phrasing", () => {
  it("appends a strategy detail so the sentence keeps its discriminator", () => {
    expect(exitReasonActivity("strategy_signal", "EMA close-through")).toBe(
      "the strategy called the exit (EMA close-through)",
    );
  });

  it("reads without one when there is no detail", () => {
    expect(exitReasonActivity("time_window_close")).toBe("the trading window closed");
  });
});
