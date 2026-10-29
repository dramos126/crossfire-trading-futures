import Module from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DB_PATH_VAR, assertDbConnectionNotLoaded, openTopstepTail } from "./topstep-tail";

const CONNECTION = path.join(process.cwd(), "src", "lib", "db", "connection.ts");
const cache = (Module as unknown as { _cache: Record<string, unknown> })._cache;

afterEach(() => {
  delete cache[CONNECTION];
});

describe("openTopstepTail — the database path is the CLI's, or it refuses", () => {
  it("throws before touching TRADING_DB_PATH when db/connection is already loaded", async () => {
    const before = process.env[DB_PATH_VAR];
    cache[CONNECTION] = {};

    await expect(openTopstepTail("/tmp/never-used.db")).rejects.toThrow(/imported before the Topstep tail opened/);
    expect(process.env[DB_PATH_VAR]).toBe(before);
  });

  it("passes a module cache that has not loaded it", () => {
    expect(() => assertDbConnectionNotLoaded({ [path.join("/x", "src", "lib", "db", "trades.ts")]: {} })).not.toThrow();
  });
});
