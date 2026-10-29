# Entry filters — read before you author or change one

- **Authoring, changing or reviewing a filter** → `docs/modules/trading/filters.md`, *Hard rules*, then *How it works*. Exit filters live in `../exit-filters/`, same doc.
- **A new param key:** check it against the strategies' keys first — a collision is bug A109 (`docs/bugs.md`).
- **Backtest parity** — a filter runs the same in the engine and the backtest, or the doc says why not. → `docs/modules/trading/backtest.md`, *Hard rules*.
- **Open work:** grep `docs/bugs.md` and `docs/punchlist.md` for `filters`.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*. Your diff updates the doc it touched, or your report says why not.
