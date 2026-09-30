#!/usr/bin/env bash
# Genera dist/Pulcro-<versión>.dmg con la app y un acceso directo a Aplicaciones.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
APP="$HOME/Applications/Pulcro.app"
STAGE="$ROOT/.build/dmg"
OUT="$ROOT/dist/Pulcro-$VERSION.dmg"

bash "$ROOT/scripts/build-app.sh"

echo "→ Preparando contenido del DMG…"
rm -rf "$STAGE" && mkdir -p "$STAGE" "$ROOT/dist"
cp -R "$APP" "$STAGE/Pulcro.app"
ln -s /Applications "$STAGE/Aplicaciones"
if [ -f "$ROOT/.build/Pulcro.icns" ]; then
  cp "$ROOT/.build/Pulcro.icns" "$STAGE/.VolumeIcon.icns"
  command -v SetFile >/dev/null && SetFile -a C "$STAGE" || true
fi

echo "→ Creando $OUT…"
rm -f "$OUT"
hdiutil create -volname "Pulcro" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$OUT" >/dev/null
codesign --force -s - "$OUT" >/dev/null 2>&1 || true
echo "✓ Listo: $OUT ($(du -h "$OUT" | cut -f1))"
