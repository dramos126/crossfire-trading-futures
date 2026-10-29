# Persistence — read before you change it

- **Tables, migrations, transactions** → `docs/modules/persistence/README.md`, *Hard rules*; then the sub-doc for the part you touch:
  - trades and skips → `docs/modules/persistence/persistence-trades.md`
  - accounts, books, app sessions → `docs/modules/persistence/persistence-accounts.md`
  - engine logs, restart state → `docs/modules/persistence/persistence-engine.md`
- **A status vocabulary spans four modules** (deployments, account state) — a new value is an `docs/architecture.md` change too.
- **Open work:** grep `docs/bugs.md` and `docs/punchlist.md` for `persistence`.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*. Your diff updates the doc it touched, or your report says why not.
