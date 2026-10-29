/**
 * An operator-facing refusal. `main` prints the message and exits non-zero;
 * anything else that escapes prints a stack, because it is a defect rather
 * than a bad invocation.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * A refusal about the session or the source every run reads — the session is
 * not complete, Topstep is unreachable — rather than about one playbook.
 * `parity-day` abandons the whole day on one; any other `CliError` from a
 * leg's run refuses that leg alone. Elsewhere it is an ordinary `CliError`.
 */
export class DayRefusal extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "DayRefusal";
  }
}
