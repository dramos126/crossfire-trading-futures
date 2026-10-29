# Pages and routes — read before you change one

Loads when a session opens a file under `src/app/`. Pointers only.

- **Every route is gated by the app session** → `docs/modules/infra/README.md`, *Every route is gated by the app session*. The exception is `api/dev/*` and `/dev` → `docs/modules/dev-tools/README.md`, *The gate*.
- **A page** → `docs/modules/ui/design-language.md`, *Hard rules*, then its surface doc: `/` and `board` → `docs/modules/ui/ui-dashboard.md`; `deployments/` → `docs/modules/ui/ui-deployments.md`; `playbooks/`, `books/` → `docs/modules/ui/ui-playbooks.md`; `settings/` → `docs/modules/ui/ui-settings.md`; `logs/` → `docs/modules/ui/ui-logs.md`. Strings → `docs/modules/ui/copy.md`.
- **A route** belongs to the module it serves — `api/deployments`, `api/groups` → `docs/modules/trading/deployments.md`; `api/books` → `docs/modules/trading/deployments-books.md`; `api/accounts`, `orders`, `positions`, `quotes`, `contracts` → `docs/modules/brokers/brokers-routing.md`; `api/auth` → `docs/modules/brokers/brokers-client.md`; `api/engine` → `docs/modules/trading/engine.md`; `api/trades`, `api/regime` → `docs/modules/persistence/persistence-trades.md`; `api/backtest` → `docs/modules/trading/backtest.md`; `api/settings` → `infra/README.md`. Unsure: `corepack yarn check:docs --owner <path>`.
- **A route that reads a runtime-named directory owes an `outputFileTracingExcludes` entry** → `infra/README.md`, *Hard rules*.
- **A route that writes deployments or touches an order is a live-state path** — it gets the reviewer. → `docs/process/agent-dispatch.md`, *Order of operations*.
- **Open work:** grep `docs/bugs.md` and `docs/punchlist.md` for the owning doc's name.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*; `corepack yarn build` for a route or page. Your diff updates the doc it touched, or your report says why not.
