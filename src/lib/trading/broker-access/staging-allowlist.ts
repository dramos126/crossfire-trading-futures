// Staging-only account allowlist, populated by `runBootSequence` in
// boot-engine.ts. Topstep accounts pass via the PRAC name-prefix
// classification; Tradovate accounts pass when the engine is pointed at
// the demo gateway (host-level live/demo split). Lives in its own
// module (not boot-assertion.ts) so the boot-assertion gate stays
// focused on the pending/passed/failed state machine that
// maybeAutoStart consumes.
//
// State semantics:
//   null               — not populated (prod env path).
//                        Callers treat null as "no filter, all accounts".
//   ReadonlySet<id>    — populated by staging boot. Engine entry points
//                        (listManagedDeployments, /api/engine route) keep
//                        only deployments whose accountId is in the set.
//
// Server-only — populated by the Node-runtime instrumentation hook. Never
// import this from client code; the set is empty in any non-server context.

interface StagingAllowlistGlobal {
  __topstepStagingAllowlist?: ReadonlySet<number> | null;
}

function store(): StagingAllowlistGlobal {
  return globalThis as unknown as StagingAllowlistGlobal;
}

export function setStagingAllowlist(ids: number[]): void {
  store().__topstepStagingAllowlist = new Set(ids);
}

export function getStagingAllowlist(): ReadonlySet<number> | null {
  return store().__topstepStagingAllowlist ?? null;
}
