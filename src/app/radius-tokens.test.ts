/**
 * Every radius in the UI is one of the four tokens `globals.css` defines in
 * its `@theme` block. That block resets Tailwind's own radius scale, so a bare
 * `rounded`, an off-scale `rounded-xl` or an arbitrary `rounded-[3px]` does
 * not fail the build — it silently renders square. This scan is what catches
 * it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const UI_ROOTS = ["components", "app"].map((d) => path.join(SRC, d));
const GLOBALS_CSS = path.join(SRC, "app", "globals.css");

// `none` is Tailwind's static zero, not a theme step, so it renders square on purpose.
const RADIUS_SIZES = new Set(["sm", "md", "lg", "full", "none"]);
const RADIUS_CLASS = /^rounded(?:-(?:[trblse]|tl|tr|br|bl|ss|se|es|ee))?(?:-(.+))?$/;
const STRING_LITERAL = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/g;
const INLINE_RADIUS = /border-?radius/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Whitespace-separated tokens of every string literal, variant prefixes (`hover:`) stripped. */
function classTokens(text: string): string[] {
  return (text.match(STRING_LITERAL) ?? []).flatMap((lit) =>
    lit
      .slice(1, -1)
      .split(/\s+/)
      .map((tok) => tok.slice(tok.lastIndexOf(":") + 1)),
  );
}

/** `null` for a tokenised radius class or a non-radius token; the offending token otherwise. */
function offScaleRadius(token: string): string | null {
  const m = RADIUS_CLASS.exec(token);
  if (!m) return null;
  return m[1] !== undefined && RADIUS_SIZES.has(m[1]) ? null : token;
}

describe("offScaleRadius", () => {
  it("accepts the four token sizes on any side, and an explicit square corner", () => {
    for (const ok of [
      "rounded-sm", "rounded-md", "rounded-lg", "rounded-full", "rounded-t-md", "rounded-bl-sm", "rounded-none", "rounded-l-none",
    ]) {
      expect(offScaleRadius(ok)).toBeNull();
    }
  });

  it("rejects bare, off-scale and arbitrary radii", () => {
    for (const bad of ["rounded", "rounded-t", "rounded-xs", "rounded-xl", "rounded-[2px]"]) {
      expect(offScaleRadius(bad)).toBe(bad);
    }
  });

  it("ignores words that only start like a radius class", () => {
    expect(offScaleRadius("roundedness")).toBeNull();
  });
});

describe("radius tokens across the UI", () => {
  const files = UI_ROOTS.flatMap(sourceFiles);

  it("every radius class is one of the four tokens", () => {
    let tokenised = 0;
    const offenders: string[] = [];
    for (const file of files) {
      for (const tok of classTokens(readFileSync(file, "utf8"))) {
        if (!tok.startsWith("rounded")) continue;
        const bad = offScaleRadius(tok);
        if (bad) offenders.push(`${path.relative(SRC, file)}: ${bad}`);
        else if (RADIUS_CLASS.test(tok)) tokenised += 1;
      }
    }
    expect(tokenised).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("no component sets a radius inline", () => {
    const offenders = files
      .filter((file) => INLINE_RADIUS.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("globals.css takes every border-radius from a token", () => {
    const values = [...readFileSync(GLOBALS_CSS, "utf8").matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(values.length).toBeGreaterThan(0);
    expect(values.filter((v) => !/^var\(--radius-(sm|md|lg|full)\)$/.test(v))).toEqual([]);
  });
});
