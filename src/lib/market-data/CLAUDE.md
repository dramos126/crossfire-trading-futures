# Market data — read before you change it

- **`MarketDataProvider`, the bar-source chain, the Databento/Parquet cache** → `docs/modules/market-data/providers.md`, *Hard rules*, then *How it works* for the part you touch. `src/lib/data/` is the same area.
- **Never read the bar cache from Bash**; the CLI's `run.json` lists what it read. → `docs/process/agent-dispatch.md`.
- **Market-data identity is not execution identity** — one market sub serves every broker. → `docs/architecture.md`.
- **Open work:** grep `docs/bugs.md` and `docs/punchlist.md` for `providers`.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*. Your diff updates the doc it touched, or your report says why not.
