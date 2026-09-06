#!/bin/bash
set -euo pipefail

CONTENTS_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
ROOT_FILE="$CONTENTS_DIR/Resources/root-path"
SCHEMA_FILE="$CONTENTS_DIR/Resources/install-schema"
EXPECTED_SCHEMA="lazurio.launchpad.macos_install.v1"

fail() {
  local message="$1"
  printf '%s\n' "$message" >&2
  exit 1
}

if [[ ! -f "$ROOT_FILE" || -L "$ROOT_FILE" || ! -f "$SCHEMA_FILE" || -L "$SCHEMA_FILE" ]]; then
  fail "Lazurio Launchpad nemá platnou instalaci. V primárním Lazurio checkoutu spusť bun run lazurio -- launchpad install."
fi
ROOT_LINE_COUNT="$(/usr/bin/wc -l < "$ROOT_FILE" | /usr/bin/tr -d '[:space:]')"
SCHEMA_LINE_COUNT="$(/usr/bin/wc -l < "$SCHEMA_FILE" | /usr/bin/tr -d '[:space:]')"
if [[ "$ROOT_LINE_COUNT" != "1" || "$SCHEMA_LINE_COUNT" != "1" ]]; then
  fail "Lazurio Launchpad má neplatný víceřádkový instalační kontrakt. Spusť znovu bun run lazurio -- launchpad install."
fi

IFS= read -r ROOT < "$ROOT_FILE" || true
IFS= read -r SCHEMA < "$SCHEMA_FILE" || true
if [[ -z "$ROOT" || "$ROOT" == *$'\n'* || "$SCHEMA" != "$EXPECTED_SCHEMA" ]]; then
  fail "Lazurio Launchpad má neplatný instalační kontrakt. Spusť znovu bun run lazurio -- launchpad install."
fi
if [[ ! -d "$ROOT" ]]; then
  fail "Nakonfigurovaný Lazurio root není dostupný: $ROOT"
fi

CANONICAL_ROOT="$(cd "$ROOT" && pwd -P)"
if [[ "$CANONICAL_ROOT" != "$ROOT" ]]; then
  fail "Nakonfigurovaný Lazurio root už není kanonický. Spusť znovu bun run lazurio -- launchpad install."
fi

LAUNCHER="$CANONICAL_ROOT/Launchpad.command"
if [[ ! -f "$LAUNCHER" || -L "$LAUNCHER" || ! -x "$LAUNCHER" ]]; then
  fail "V nakonfigurovaném Lazurio rootu chybí spustitelný Launchpad.command."
fi

# Execute the canonical human entrypoint directly. Opening a .command document
# asks LaunchServices for Terminal; a native app must never do that.
exec /bin/bash "$LAUNCHER"
