# UI components — read before you change one

Loads when a session opens a file under `src/components/`. Pointers only.

- **Every component, chart or layout:** `docs/modules/ui/design-language.md`, *Hard rules*, as the checklist — global tokens, the shared chart layer, no new visual idiom; a terminal, not a SaaS page. Then the surface doc:
  - `board/` → `docs/modules/ui/ui-dashboard.md`
  - `deployment/` → `docs/modules/ui/ui-deployments.md`
  - `playbook/`, `book/`, `backtest/` → `docs/modules/ui/ui-playbooks.md`
  - `settings/` → `docs/modules/ui/ui-settings.md`
  - `chart/`, `account/` → `design-language.md`, *How it works*
- **Any label, description, tooltip or string a user sees** → `docs/modules/ui/copy.md`, *Hard rules*. Plain sentences; playbook display names, never keys.
- **Effects, refs, stale closures** → `docs/modules/ui/react-pitfalls.md`.
- **Charts** → the `dataviz` skill before the first line of chart code.
- **Open work:** grep `docs/bugs.md` and `docs/punchlist.md` for `design-language` or the surface doc's name.
- **Tests** → `docs/modules/testing/patterns.md`, *Hard rules*. Your diff updates the doc it touched, or your report says why not.
