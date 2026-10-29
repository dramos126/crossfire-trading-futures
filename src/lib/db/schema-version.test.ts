/**
 * `SCHEMA_VERSION` is hand-bumped, and a `web` process serves as soon as
 * `PRAGMA user_version` reaches it. A migration added or changed without the
 * bump lets the web side read a column the engine has not migrated yet (the
 * first failing read is a new `deployments` column through
 * `listManagedDeployments()`). This pins the source of every migration the
 * boot graph registers against the version, so the change and the bump land
 * together.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The strategy registry is a webpack `require.context`, which vitest cannot
// evaluate, and it registers no migration.
vi.mock("@/lib/trading/strategies", () => ({ STRATEGIES: {}, getStrategy: () => undefined, listStrategies: () => [] }));
vi.mock("@/lib/trading/strategies/index", () => ({ STRATEGIES: {}, getStrategy: () => undefined, listStrategies: () => [] }));

/**
 * The version and the migrations it describes. On a failure: bump
 * `SCHEMA_VERSION` in `connection.ts` if a migration changed, then copy both
 * numbers the failure prints here. A toolchain upgrade that only reformats the
 * transpiled source moves the hash without a schema change; repin the hash
 * alone for that.
 */
const PINNED = {
  schemaVersion: 3,
  migrationsHash: "e4a9a99cf776aed47f7aa5a77973d24fd7afd0c90b5eec13c73bbe02a2d6c291",
};

const SRC_ROOT = resolve(__dirname, "../..");
const CALL_SITE = /^\s*registerMigration\(/gm;

function registerMigrationCallSites(): number {
  const files = readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" }).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  return files.reduce(
    (n, f) => n + (readFileSync(join(SRC_ROOT, f), "utf8").match(CALL_SITE)?.length ?? 0),
    0,
  );
}

function migrationsHash(sources: readonly string[]): string {
  // Sorted, so a module loading earlier or later is not a schema change;
  // whitespace collapsed, so re-indenting a block is not one either.
  const normalised = sources.map((s) => s.replace(/\s+/g, " ").trim()).sort();
  return createHash("sha256").update(normalised.join("\n")).digest("hex");
}

describe("SCHEMA_VERSION", () => {
  it("is bumped with any migration the boot graph registers", async () => {
    await import("@/lib/trading/engine/boot/boot-engine");
    const { SCHEMA_VERSION, registeredMigrations } = await import("./connection");
    const migrations = registeredMigrations();
    // A block in a module the boot graph does not import moves no hash, and
    // on a split install its table is never created (persistence README).
    expect(migrations.length, "a registerMigration call site is outside the boot graph").toBe(
      registerMigrationCallSites(),
    );

    const found = {
      schemaVersion: SCHEMA_VERSION,
      migrationsHash: migrationsHash(migrations.map((fn) => fn.toString())),
    };
    const message =
      found.migrationsHash !== PINNED.migrationsHash && found.schemaVersion === PINNED.schemaVersion
        ? `a registerMigration block changed and SCHEMA_VERSION did not — bump it in connection.ts, then pin ${JSON.stringify(found)} here`
        : `repin ${JSON.stringify(found)} in PINNED`;
    expect(found, message).toEqual(PINNED);
  });
});
