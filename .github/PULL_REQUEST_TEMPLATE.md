## What and why
<!-- One or two sentences. Link the issue: Fixes #123 -->

## How it was checked
<!-- Tests added or changed; a screenshot for anything visible. -->

## Checklist
- [ ] Targets `dev`, not `main`
- [ ] `./scripts/dev-sync.sh`, `claude plugin validate .` (no TypeScript errors) and `claude plugin test .` pass
- [ ] Bar text is identical on desktop, VS Code and terminal (a surface-specific change has its own test)
- [ ] No new network or model calls outside `/cmaxx-update` and `/cmaxx-handoff`; nothing blocks a message
- [ ] Prices changed? `PRICES_DATE` bumped and `prices.json` regenerated
- [ ] README and CHANGELOG updated if users will notice the change
