/**
 * A migration adds; it never drops or renames a table, a column or an index,
 * and never adds a constraint or rewrites a key the running build depends on
 * (persistence README, *Hard rules*). On a hand-over the standby migrates the
 * file while the active engine still runs the previous build against it, so a
 * column renamed or an index dropped under that build fails its next query or
 * lets it write a row the index used to refuse; a unique index, a trigger or
 * a CHECK added under it refuses a write it has always made; and a key column
 * rewritten under it (`renameStrategyKeys`) leaves its in-memory rows naming
 * keys that no longer exist — mid-session, on a live engine.
 *
 * Read from the source files rather than from the registered callbacks,
 * because a callback is often one line calling a helper and its `toString()`
 * would show none of the SQL. The files read are every file that registers a
 * migration **and every file those import, transitively** — a helper in
 * another module runs inside the migration just the same. The scan is by
 * file, so a runtime statement in a scanned file counts too; the ratchet
 * names those.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(__dirname, "../..");
const REGISTERS_MIGRATION = /^\s*registerMigration\(/m;
const IMPORT_FROM = /^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm;
/** Columns a running build holds in memory as identity. A new one joins. */
const KEY_COLUMNS = ["strategy_key"];
const DESTRUCTIVE = new RegExp(
  [
    String.raw`DROP\s+(?:TABLE|COLUMN|INDEX|VIEW|TRIGGER)`,
    String.raw`RENAME\s+(?:TO|COLUMN)`,
    String.raw`CREATE\s+UNIQUE\s+INDEX`,
    String.raw`CREATE\s+TRIGGER`,
    String.raw`SET\s+(?:${KEY_COLUMNS.join("|")})\s*=`,
  ]
    .map((p) => `\\b${p}`)
    .join("|"),
  "gi",
);
/** Upper case only: `check(` is a common function name, and the SQL here is upper case. */
const CHECK_CONSTRAINT = /\bCHECK\s*\(/g;

function statementsIn(source: string): string[] {
  return [...source.matchAll(DESTRUCTIVE), ...source.matchAll(CHECK_CONSTRAINT)].map((m) =>
    m[0].toUpperCase().replace(/\s+/g, " ").replace(/\s*\($/, " ("),
  );
}

/**
 * The ratchet: statements that predate the rule, per file. A new entry is a
 * schema change a hand-over cannot ship: it says why, and the deploy that
 * carries it stops the old engine first.
 */
const ALLOWED: Record<string, Record<string, number>> = {
  // The books-per-account merge (2026-10-11): rebuilt into `_next` tables and
  // swapped, inside one transaction, only while the old shape is present; and
  // the per-playbook index its successor replaced. The per-account unique
  // index came with the merge and has run on every live database.
  "lib/db/books.ts": { "DROP INDEX": 2, "DROP TABLE": 2, "RENAME TO": 2, "CREATE UNIQUE INDEX": 1 },
  // The per-(book, playbook) unique index replaced by the per-cell one; both
  // have run on every live database, and `IF NOT EXISTS` no-ops the create.
  "lib/db/deployment-groups.ts": { "DROP INDEX": 1, "CREATE UNIQUE INDEX": 1 },
  // The once-per-signal index, guarded on its own absence after a dedupe.
  "lib/db/skipped-signals.ts": { "CREATE UNIQUE INDEX": 1 },
  // Single-row tables pinned to id 1 at their creation; `IF NOT EXISTS`
  // no-ops on every database that has them, so nothing is added under a
  // running build.
  "lib/db/auth.ts": { "CHECK (": 2 },
  "lib/db/engine-restart.ts": { "CHECK (": 1 },
  "lib/db/lease.ts": { "CHECK (": 1 },
  "lib/db/web-account.ts": { "CHECK (": 1 },
  // `renameStrategyKeys`, which rewrites nothing until `renamed-keys.ts`
  // gains a pair — a change that needs a stop-and-start deploy (README); and
  // `updateDeployment`, a runtime write in the same file, not a migration.
  "lib/db/deployments.ts": { "SET STRATEGY_KEY =": 2 },
};

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC_ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every file that registers a migration, and everything they import. */
function migrationFiles(): string[] {
  const all = readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(SRC_ROOT, f));
  const queue = all.filter((f) => REGISTERS_MIGRATION.test(readFileSync(f, "utf8")));
  const seen = new Set(queue);
  while (queue.length > 0) {
    const file = queue.pop() as string;
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_FROM)) {
      const target = resolveImport(file, match[1]);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen];
}

function destructiveStatements(files: string[]): Record<string, Record<string, number>> {
  const found: Record<string, Record<string, number>> = {};
  for (const file of files) {
    for (const statement of statementsIn(withoutComments(readFileSync(file, "utf8")))) {
      const key = relative(SRC_ROOT, file).split("\\").join("/");
      found[key] ??= {};
      found[key][statement] = (found[key][statement] ?? 0) + 1;
    }
  }
  return found;
}

describe("migrations", () => {
  it("add and never drop, rename, constrain or rewrite a key, beyond the statements that predate the rule", () => {
    expect(destructiveStatements(migrationFiles())).toEqual(ALLOWED);
  });

  it("reach the helpers a migration calls in another file", () => {
    const files = migrationFiles().map((f) => relative(SRC_ROOT, f).split("\\").join("/"));
    expect(files).toContain("lib/trading/strategies/renamed-keys.ts");
  });

  it("catch each statement shape, so a pattern that stops matching fails here", () => {
    const sample = [
      "DROP TABLE t",
      "ALTER TABLE t RENAME COLUMN a TO b",
      "CREATE UNIQUE INDEX IF NOT EXISTS i ON t(a)",
      "CREATE TRIGGER trg AFTER INSERT ON t BEGIN SELECT 1; END",
      "ALTER TABLE t ADD COLUMN n INTEGER CHECK (n > 0)",
      "UPDATE OR IGNORE t SET strategy_key = ? WHERE strategy_key = ?",
    ].join("\n");
    expect(statementsIn(sample)).toEqual([
      "DROP TABLE",
      "RENAME COLUMN",
      "CREATE UNIQUE INDEX",
      "CREATE TRIGGER",
      "SET STRATEGY_KEY =",
      "CHECK (",
    ]);
    // A plain index, an added nullable column and a function named check are not.
    expect(statementsIn("CREATE INDEX IF NOT EXISTS i ON t(a); ALTER TABLE t ADD COLUMN n INTEGER; check(x)")).toEqual(
      [],
    );
  });
});
