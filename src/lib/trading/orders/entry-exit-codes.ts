export const EntryExitCode = {
  ENTRY_STALE: "entry_stale",
  ENTRY_NOT_FILLED: "entry_not_filled",
  EXIT_IN_FLIGHT: "exit_in_flight",
  /** The broker reports flat on the contract the exit resolved to, while the
   *  engine still holds an `open` trade row for that deployment. Nothing was
   *  submitted, so the caller must not record a completed exit — thrown for
   *  the same reason `EXIT_IN_FLIGHT` is, because only a throw can skip a
   *  caller's mirror teardown. */
  EXIT_FLAT_MISMATCH: "exit_flat_mismatch",
  /** The broker's position on the contract is the opposite side from the
   *  engine's, so the closing order would add to it. Nothing was submitted;
   *  callers keep their mirror, as for any throw. */
  EXIT_SIDE_MISMATCH: "exit_side_mismatch",
} as const;

export type EntryExitCodeValue = typeof EntryExitCode[keyof typeof EntryExitCode];
