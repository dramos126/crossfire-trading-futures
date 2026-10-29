# Brokers — read before you change anything here

Loads when a session opens a file under `src/lib/brokers/`. Pointers only.

- **First, always:** `docs/modules/brokers/README.md`, *Hard rules*, in full — it holds the live-account block: auto-trading on a live (funded) account is prohibited, one predicate, three enforcement layers, an unclassifiable account is refused. Never add a second predicate. The account-prefix table is in `docs/modules/brokers/topstep.md`.
- **`topstep/`** — REST, auth, SignalR hubs, orders, brackets, classification → `docs/modules/brokers/topstep.md`.
- **`tradovate/`** — auth, OSO orders, the failure envelope, the realtime WS → `docs/modules/brokers/tradovate.md`.
- **`BrokerPlugin`, the registry, runtime validation of responses** → `brokers/README.md`, *How it works*.
- **Per-account routing, account events** → `docs/modules/brokers/brokers-routing.md`.
- **App session, browser state** → `docs/modules/brokers/brokers-client.md`.
- **A webhook URL or token is a credential** — redact on read, write-only on write. → `brokers/README.md`.
- **Every change here gets the reviewer.** → `docs/process/agent-dispatch.md`, *Order of operations*.
- **Open work here:** grep `docs/bugs.md` and `docs/punchlist.md` for `brokers`, `topstep` or `tradovate`.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*. Your diff updates the doc it touched, or your report says why not.
