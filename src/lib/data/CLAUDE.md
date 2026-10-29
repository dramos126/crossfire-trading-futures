# Data (bar cache, Parquet) — read before you change it

- **The cache, its layout and the bar-source chain** → `docs/modules/market-data/providers.md`, *Hard rules*, then *How it works*. `src/lib/market-data/` is the same area.
- **The cache mount and the nightly refresh** → `docs/modules/infra/README.md`, *The Databento cache mount*.
- **Never read the bar cache from Bash.** → `docs/process/agent-dispatch.md`.
- **Open work:** grep `docs/bugs.md` and `docs/punchlist.md` for `providers`.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*. Your diff updates the doc it touched, or your report says why not.
