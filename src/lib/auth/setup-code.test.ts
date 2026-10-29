import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeSetupCode,
  ensureSetupCode,
  resetSetupCodeForTests,
  SETUP_CODE_LINE_PREFIX,
  setupCodeMatches,
} from "./setup-code";

let write: ReturnType<typeof vi.spyOn>;

function printedLines(): string[] {
  return write.mock.calls.map((c: unknown[]) => String(c[0])).filter((s: string) => s.startsWith(SETUP_CODE_LINE_PREFIX));
}

function printedCode(index = 0): string {
  return printedLines()[index].slice(SETUP_CODE_LINE_PREFIX.length).trim();
}

beforeEach(() => {
  resetSetupCodeForTests();
  write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  write.mockRestore();
});

describe("the one-time setup code", () => {
  it("is 32 characters, printed once to stdout however often it is asked for", () => {
    ensureSetupCode();
    ensureSetupCode();
    expect(printedLines()).toHaveLength(1);
    expect(printedCode()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("matches only itself, and nothing before it exists", () => {
    expect(setupCodeMatches("")).toBe(false);
    ensureSetupCode();
    const code = printedCode();
    expect(setupCodeMatches(code)).toBe(true);
    expect(setupCodeMatches(` ${code}\n`)).toBe(true);
    expect(setupCodeMatches(code.slice(1))).toBe(false);
    expect(setupCodeMatches(code.toUpperCase().replace(/[0-9]/g, "z"))).toBe(false);
  });

  it("is consumed, and a later need prints a new one", () => {
    ensureSetupCode();
    const first = printedCode();
    consumeSetupCode();
    expect(setupCodeMatches(first)).toBe(false);
    ensureSetupCode();
    expect(printedLines()).toHaveLength(2);
    expect(printedCode(1)).not.toBe(first);
  });

  it("is one per process, not per module graph — a second copy of the module checks the code the first printed", async () => {
    ensureSetupCode();
    vi.resetModules();
    const fresh = await import("./setup-code");
    fresh.ensureSetupCode();
    expect(printedLines()).toHaveLength(1);
    expect(fresh.setupCodeMatches(printedCode())).toBe(true);
  });

  // The pipe persists lines in engine_logs, serves /logs and pages Discord.
  it("never goes through the log pipe", () => {
    const source = readFileSync(join(__dirname, "setup-code.ts"), "utf8");
    expect(source).not.toMatch(/@\/lib\/logger|@\/lib\/logging|console\./);
  });
});
