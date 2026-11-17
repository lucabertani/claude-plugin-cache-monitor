#!/bin/sh
# Releases the committed code on `main`: tags it, puts the local LIVE copy on it (every chat
# outside this project then runs it), and pushes `main` and the tag when an `origin` remote
# exists. Users install `main`'s HEAD, so pushing `main` IS the public release: work on `dev`
# and merge into `main` only to release.
#   ./scripts/release.sh 0.4.1              release a new version
#   ./scripts/release.sh --rollback 0.4.0   put live back on an earlier release (local only)
# Then run /reload-plugins in open chats, or restart the app.
set -e
cd "$(dirname "$0")/.."
LIVE=../cache-maxxing-live

if [ "$1" = "--rollback" ]; then
  git -C "$LIVE" checkout -q "v$2"
  echo "live is back on v$2. Run /reload-plugins in open chats."
  exit 0
fi

V="$1"
[ -n "$V" ] || { echo "usage: $0 <version> | --rollback <version>"; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { echo "release from main (merge dev into main first)"; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "commit your changes first"; exit 1; }
grep -q "\"version\": \"$V\"" .claude-plugin/plugin.json || { echo "set \"version\": \"$V\" in .claude-plugin/plugin.json and commit first"; exit 1; }
claude plugin validate . >/dev/null

# /cmaxx-update reads prices.json from main: it must match the bundled table, and a price
# change needs a new date, or users who downloaded the old table keep it (it wins only if newer)
bun scripts/prices-json.ts
git diff --quiet prices.json || { echo "prices.json was out of date: commit the regenerated file first"; exit 1; }
PREV=$(git describe --tags --abbrev=0 2>/dev/null || true)
if [ -n "$PREV" ] && git cat-file -e "$PREV:prices.json" 2>/dev/null && ! git diff --quiet "$PREV" -- prices.json; then
  OLD_DATE=$(git show "$PREV:prices.json" | grep '"sourceDate"')
  NEW_DATE=$(grep '"sourceDate"' prices.json)
  [ "$OLD_DATE" != "$NEW_DATE" ] || { echo "prices changed since $PREV but PRICES_DATE did not: bump it in hooks/logic.ts"; exit 1; }
fi

claude plugin test . | tail -3
claude plugin test . >/dev/null 2>&1 || { echo "tests fail: not released"; exit 1; }
git tag -a "v$V" -m "cache-maxxing $V"
git -C "$LIVE" checkout -q "v$V"
echo "released v$V to live. Run /reload-plugins in open chats, or restart the app."
if git remote get-url origin >/dev/null 2>&1; then
  git push origin main "v$V"
  echo "pushed main and v$V: users get it on their next update."
else
  echo "no origin remote: nothing pushed."
fi
