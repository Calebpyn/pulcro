#!/usr/bin/env bash
# Compila la ventana nativa y arma ~/Applications/Pulcro.app
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Pulcro.app"
NODE="$(command -v node)"
BUILD="$ROOT/.build"
mkdir -p "$BUILD" "$HOME/Applications"

echo "→ Compilando ventana nativa…"
SWIFT_ARGS=(-O "$ROOT/macos/main.swift" -o "$BUILD/Pulcro" -framework Cocoa -framework WebKit)
if ! swiftc "${SWIFT_ARGS[@]}" 2>"$BUILD/swift.log"; then
  # Algunas Command Line Tools traen el modulemap de SwiftBridging duplicado y un SDK
  # más nuevo que el compilador. Se oculta el duplicado con un overlay (sin tocar el sistema).
  echo "  (aplicando arreglo para Command Line Tools)"
  CLT=/Library/Developer/CommandLineTools
  : > "$BUILD/empty.modulemap"
  cat > "$BUILD/overlay.yaml" <<YAML
{ "version": 0, "case-sensitive": "false", "roots": [
  { "type": "file", "name": "$CLT/usr/include/swift/module.modulemap", "external-contents": "$BUILD/empty.modulemap" } ] }
YAML
  SDK="$(ls -d $CLT/SDKs/MacOSX15*.sdk 2>/dev/null | sort -V | tail -1)"
  swiftc ${SDK:+-sdk "$SDK"} -vfsoverlay "$BUILD/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$BUILD/overlay.yaml" "${SWIFT_ARGS[@]}" 2>"$BUILD/swift.log" \
    || { grep error "$BUILD/swift.log" | head -5; exit 1; }
fi

echo "→ Generando ícono…"
ICONSET="$BUILD/Pulcro.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
qlmanage -t -s 1024 -o "$BUILD" "$ROOT/macos/icon.svg" >/dev/null 2>&1 || true
if [ -f "$BUILD/icon.svg.png" ]; then
  for s in 16 32 128 256 512; do
    sips -z $s $s "$BUILD/icon.svg.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$BUILD/icon.svg.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$BUILD/Pulcro.icns"
fi

echo "→ Armando $APP…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/Pulcro" "$APP/Contents/MacOS/Pulcro"
[ -f "$BUILD/Pulcro.icns" ] && cp "$BUILD/Pulcro.icns" "$APP/Contents/Resources/Pulcro.icns"
ENGINE="$APP/Contents/Resources/engine"
mkdir -p "$ENGINE"
cp -R "$ROOT/src" "$ROOT/public" "$ROOT/package.json" "$ENGINE/"
[ -f "$ROOT/package-lock.json" ] && cp "$ROOT/package-lock.json" "$ENGINE/"
(cd "$ENGINE" && npm ci --omit=dev --no-fund --no-audit --silent)
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Pulcro</string>
  <key>CFBundleDisplayName</key><string>Pulcro</string>
  <key>CFBundleIdentifier</key><string>dev.local.pulcro</string>
  <key>CFBundleExecutable</key><string>Pulcro</string>
  <key>CFBundleIconFile</key><string>Pulcro</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSAppleEventsUsageDescription</key><string>Pulcro usa Finder para vaciar la Papelera cuando tú se lo pides.</string>
  <key>PulcroNode</key><string>$NODE</string>
</dict></plist>
PLIST
codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
touch "$APP"
echo "✓ Listo: $APP"
