import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNodeRequireContext, listRelative } from "./node-require-context";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "require-context-test-"));
  mkdirSync(path.join(dir, "mods", "nested"), { recursive: true });
  writeFileSync(path.join(dir, "mods", "a.strategy.js"), "module.exports = { default: 'a' };\n");
  writeFileSync(path.join(dir, "mods", "nested", "b.strategy.js"), "module.exports = { default: 'b' };\n");
  writeFileSync(path.join(dir, "mods", "notes.txt"), "not a module\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listRelative", () => {
  it("lists ./-relative, /-separated paths, deep only when asked", () => {
    const root = path.join(dir, "mods");
    expect(listRelative(root, true)).toEqual(["./a.strategy.js", "./nested/b.strategy.js", "./notes.txt"]);
    expect(listRelative(root, false)).toEqual(["./a.strategy.js", "./notes.txt"]);
  });
});

describe("installNodeRequireContext", () => {
  it("gives a CommonJS module a require.context over its own directory, filtered by its regex", () => {
    const registry = path.join(dir, "registry.js");
    writeFileSync(
      registry,
      [
        "const ctx = require.context('./mods', true, /\\.strategy\\.js$/);",
        "module.exports = ctx.keys().map((key) => [key, ctx(key).default]);",
      ].join("\n"),
    );

    installNodeRequireContext();
    const loaded: unknown = createRequire(import.meta.url)(registry);

    expect(loaded).toEqual([
      ["./a.strategy.js", "a"],
      ["./nested/b.strategy.js", "b"],
    ]);
  });

  it("leaves a module that never calls require.context as it was", () => {
    const plain = path.join(dir, "plain.js");
    writeFileSync(plain, "module.exports = typeof require.context;\n");

    installNodeRequireContext();

    expect(createRequire(import.meta.url)(plain)).toBe("undefined");
  });
});
