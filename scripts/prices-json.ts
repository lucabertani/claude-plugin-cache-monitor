// Writes prices.json (what /cache-monitor-update downloads from main) from the bundled table in
// hooks/logic.ts, so the two never drift. Run: node scripts/prices-json.ts (Node 22.18+ runs
// TypeScript as is; the .ts in the import is what Node's resolver needs).
// release.sh runs it and refuses to release while prices.json is out of date.
import { writeFileSync } from 'node:fs'

import { bundledPrices } from '../hooks/logic.ts'

writeFileSync(new URL('../prices.json', import.meta.url), `${JSON.stringify(bundledPrices(), null, 2)}\n`)
