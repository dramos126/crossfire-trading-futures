/**
 * The Strategies page is retired and the Playbook pages took its jobs. Two
 * things must hold for that to stay true: nothing in the app links to the old
 * route, and a stale bookmark or tab still lands on the page that replaced it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

const SRC = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

// A route literal: a quote or backtick, then the path. `@/lib/trading/strategies`
// and `../strategies` are module imports and never start with a bare `/`.
const ROUTE_LITERAL = (route: string) => new RegExp(`["'\`]${route}(?=[/"'\`?#])`);

describe("links to the retired Strategies page", () => {
  const files = sourceFiles(SRC);

  it("scans the app's source", () => {
    // The scan finds the route that replaced it, so a broken walk cannot pass
    // as a clean one.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => ROUTE_LITERAL("/playbooks").test(readFileSync(f, "utf8")))).toBe(true);
  });

  it("finds no link to /strategies anywhere in the app", () => {
    const offenders = files
      .filter((f) => ROUTE_LITERAL("/strategies").test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});

describe("an old /strategies URL", () => {
  async function redirects() {
    expect(nextConfig.redirects).toBeTypeOf("function");
    return nextConfig.redirects!();
  }

  it("redirects the list to /playbooks", async () => {
    expect(await redirects()).toContainEqual(
      expect.objectContaining({ source: "/strategies", destination: "/playbooks", permanent: false }),
    );
  });

  it("redirects a strategy's page to the playbook with the same key", async () => {
    expect(await redirects()).toContainEqual(
      expect.objectContaining({
        source: "/strategies/:key",
        destination: "/playbooks/:key",
        permanent: false,
      }),
    );
  });

  it("has no page left to shadow the redirect", () => {
    expect(() => statSync(join(SRC, "app", "strategies"))).toThrow();
  });
});
