#!/bin/sh
# Builds the DEV copy of the plugin, named cache-maxxing-dev, into this project's
# .claude/skills/ folder. Claude Code loads it only in chats opened in this project
# and reloads it when the files change. Run after every edit to hooks/, types/, tests/ or .claude-plugin/plugin.json.
#
# Why a copy with another name: Claude Code won't load two plugins with the same
# name, and the installed LIVE copy (cache-maxxing) always wins (FACTS F28).
set -e
cd "$(dirname "$0")/.."
DEST=.claude/skills/cache-maxxing-dev

mkdir -p "$DEST"
rm -rf "$DEST/hooks" "$DEST/types" "$DEST/tests"
mkdir -p "$DEST/.claude-plugin"
cp .claude-plugin/plugin.json "$DEST/.claude-plugin/plugin.json"
cp -R hooks types tests "$DEST/"

# Rename: the manifest, the state owner in code and contract, and test references.
sed -i '' 's/"name": "cache-maxxing"/"name": "cache-maxxing-dev"/' "$DEST/.claude-plugin/plugin.json"
for f in $(find "$DEST/hooks" "$DEST/types" "$DEST/tests" -type f); do
  sed -i '' "s/'cache-maxxing'/'cache-maxxing-dev'/g" "$f"
done

echo "dev copy synced to $DEST"
