# Exit filters — read before you author or change one

- **Authoring, changing or reviewing one** → `docs/modules/trading/filters.md`, *Hard rules*, then *How it works*. Entry filters live in `../filters/`, same doc.
- **Exits are a money path** — an exit filter's change gets the reviewer, and the exit reasons it emits come from `docs/modules/logging/logging-vocabulary.md`. → `docs/modules/trading/engine-exits.md`.
- **Backtest parity** → `docs/modules/trading/backtest.md`, *Hard rules*.
- **Open work:** grep `docs/bugs.md` and `docs/punchlist.md` for `filters`.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*. Your diff updates the doc it touched, or your report says why not.
