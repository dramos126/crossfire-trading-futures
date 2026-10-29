# Logging — read before you emit or change a log line

- **The pipe, the scrub, burst collapse, the privacy boundary** → `docs/modules/logging/README.md`, *Hard rules*; then `docs/modules/logging/logging-pipe.md`.
- **Events, alerts, exit reasons — the words** → `docs/modules/logging/logging-vocabulary.md`. A mistyped event name downgrades a line silently; use the constants.
- **The engine's lines and Discord** → `docs/modules/trading/engine-logging.md`; `src/lib/notify/` is that area.
- **Plain sentences; non-technical readers are the audience.** → `docs/modules/ui/copy.md`, *Hard rules*.
- **Open work:** grep `docs/bugs.md` and `docs/punchlist.md` for `logging`.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*. Your diff updates the doc it touched, or your report says why not.
