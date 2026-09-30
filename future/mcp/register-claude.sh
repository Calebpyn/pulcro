#!/usr/bin/env bash
# Registra el servidor MCP de Pulcro en Claude Code y Claude Desktop.
# Usa el motor empaquetado en Pulcro.app (corre `npm run build:app` antes).
set -euo pipefail
APP="$HOME/Applications/Pulcro.app"
[ -d "$APP" ] || APP="/Applications/Pulcro.app"
MCP="$APP/Contents/Resources/engine/src/mcp.js"
NODE="$(command -v node)"
[ -f "$MCP" ] || { echo "No encontré $MCP. Corre primero: npm run build:app"; exit 1; }

if command -v claude >/dev/null; then
  claude mcp remove pulcro --scope user >/dev/null 2>&1 || true
  claude mcp add pulcro --scope user -- "$NODE" "$MCP" >/dev/null
  echo "✓ Claude Code: servidor 'pulcro' registrado (scope user)"
fi

CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
if [ -d "$(dirname "$CFG")" ]; then
  [ -f "$CFG" ] && cp "$CFG" "$CFG.bak-pulcro"
  python3 - "$CFG" "$NODE" "$MCP" <<'PY'
import json, os, sys
cfg, node, mcp = sys.argv[1:]
data = json.load(open(cfg)) if os.path.exists(cfg) else {}
data.setdefault('mcpServers', {})['pulcro'] = {'command': node, 'args': [mcp]}
json.dump(data, open(cfg, 'w'), indent=2)
PY
  echo "✓ Claude Desktop: 'pulcro' agregado (respaldo en claude_desktop_config.json.bak-pulcro). Reinicia Claude Desktop."
fi
