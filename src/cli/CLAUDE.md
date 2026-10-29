# Backtest CLI — read before you change it

- **The CLI's flags, refusals, artifact layout and run lock** → `docs/modules/trading/backtest.md`, *The CLI*; the result shapes and the engine↔backtest parity contract are its *Hard rules*.
- **Running it** is the `backtest-run` skill: one process at a time, CPU cost stated first, artifacts on the mount, never a raw `trades.jsonl` read.
- **A batch process states its core budget** (`BACKTEST_WORKERS`) → `docs/modules/infra/README.md`, *Hard rules*.
- **Open work:** grep `docs/bugs.md` and `docs/punchlist.md` for `backtest`.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*. Your diff updates the doc it touched, or your report says why not.
