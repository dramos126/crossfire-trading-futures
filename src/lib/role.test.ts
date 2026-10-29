import { describe, it, expect, afterEach } from "vitest";
import { appRole, readInternalSecret, runsEngine, servesWeb } from "./role";

const original = process.env.CROSSFIRE_ROLE;

afterEach(() => {
  if (original === undefined) delete process.env.CROSSFIRE_ROLE;
  else process.env.CROSSFIRE_ROLE = original;
});

describe("the process role", () => {
  it("is all when unset or empty — today's single process", () => {
    delete process.env.CROSSFIRE_ROLE;
    expect(appRole()).toBe("all");
    process.env.CROSSFIRE_ROLE = "";
    expect(appRole()).toBe("all");
  });

  it.each([
    ["all", true, true],
    ["web", false, true],
    ["engine", true, false],
  ] as const)("%s runs the engine: %s, serves the web: %s", (role, engine, web) => {
    process.env.CROSSFIRE_ROLE = role;
    expect(appRole()).toBe(role);
    expect(runsEngine()).toBe(engine);
    expect(servesWeb()).toBe(web);
  });

  it("throws on anything else, naming the three it accepts", () => {
    process.env.CROSSFIRE_ROLE = "Engine";
    expect(() => appRole()).toThrow('CROSSFIRE_ROLE="Engine" is not a role — use one of all, web, engine');
    expect(() => runsEngine()).toThrow();
  });
});

describe("the internal secret", () => {
  const originalSecret = process.env.CROSSFIRE_INTERNAL_SECRET;
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CROSSFIRE_INTERNAL_SECRET;
    else process.env.CROSSFIRE_INTERNAL_SECRET = originalSecret;
  });

  const LONG = "a".repeat(32);

  it.each([
    ["unset", undefined, "CROSSFIRE_INTERNAL_SECRET is not set"],
    ["empty", "", "CROSSFIRE_INTERNAL_SECRET is not set"],
    ["whitespace", "   \n\t ", "CROSSFIRE_INTERNAL_SECRET is not set"],
    ["31 characters", "a".repeat(31), "CROSSFIRE_INTERNAL_SECRET is 31 characters once trimmed; it needs at least 32"],
    ["short once trimmed", ` ${"a".repeat(30)}  `, "CROSSFIRE_INTERNAL_SECRET is 30 characters once trimmed; it needs at least 32"],
  ])("has no usable secret when %s, and says why", (_label, value, problem) => {
    if (value === undefined) delete process.env.CROSSFIRE_INTERNAL_SECRET;
    else process.env.CROSSFIRE_INTERNAL_SECRET = value;
    expect(readInternalSecret()).toEqual({ secret: null, problem });
  });

  it("answers 32 characters or more, trimmed", () => {
    process.env.CROSSFIRE_INTERNAL_SECRET = LONG;
    expect(readInternalSecret()).toEqual({ secret: LONG, problem: null });
    process.env.CROSSFIRE_INTERNAL_SECRET = `  ${LONG}\n`;
    expect(readInternalSecret()).toEqual({ secret: LONG, problem: null });
  });
});
