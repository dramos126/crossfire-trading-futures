# Trading engine — read before you change it

This file loads when a session opens a file in this folder. Pointers only; each rule lives in the doc it names.

- **Before any change:** `docs/modules/trading/engine.md`, *Hard rules*, whole. Then the one sub-doc for the part you touch:
  - exits, fills, brackets, break-even → `docs/modules/trading/engine-exits.md`
  - flatten actors, the watchdog → `docs/modules/trading/engine-flatten.md`
  - session close, pause windows → `docs/modules/trading/engine-session-close.md`
  - bars, hubs, reconciliation → `docs/modules/trading/engine-realtime.md`
  - boot, restart, the clean-shutdown marker → `docs/modules/trading/engine-boot.md`
  - clock jobs → `docs/modules/trading/engine-jobs.md`
  - log lines, Discord → `docs/modules/trading/engine-logging.md`; the words to use are in `docs/modules/logging/logging-vocabulary.md`
- **Where new code goes.** → `engine.md`, *Where new code goes — the default is a satellite*.
- **Anything that decides what the engine may trade** (account, broker, live-account refusal) reads `docs/modules/brokers/README.md`, *Hard rules*, in full. One predicate; never a second.
- **A new loop, interval or background process, a vocabulary spanning modules, or a rule about what needs bars** → check `docs/architecture.md`; nothing flags it for you (`docs/process/documentation.md`).
- **Money and live-state paths get the reviewer** — orders, brackets, fills, exits, position state. → `docs/process/agent-dispatch.md`, *Order of operations*.
- **Open work here:** grep `docs/bugs.md` and `docs/punchlist.md` for `engine`.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*; cite a `bugs.md` id, never a phase name. Your diff updates the doc it touched, or your report says why not.
