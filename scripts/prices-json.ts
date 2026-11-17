// Writes prices.json (what /cmaxx-update downloads from main) from the bundled table in
// hooks/logic.ts, so the two never drift. Run: bun scripts/prices-json.ts
// release.sh runs it and refuses to release while prices.json is out of date.
import { bundledPrices } from '../hooks/logic'

await Bun.write(new URL('../prices.json', import.meta.url), `${JSON.stringify(bundledPrices(), null, 2)}\n`)
