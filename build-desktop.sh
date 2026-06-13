#!/usr/bin/env bash
set -e

echo "==========================================="
echo "   Building Codex Proxy Desktop App"
echo "==========================================="

# Navigate to script directory to ensure relative paths work
cd "$(dirname "$0")"

PLATFORM=${1:-mac}
echo "Target platform: $PLATFORM"

echo ""
echo "[1/4] Building native modules..."
cd native
npm run build
cd ..

echo ""
echo "[2/4] Building Core Server & Web Frontend..."
npm run build

echo ""
echo "[3/4] Building Electron Wrapper..."
cd packages/electron
npm run build

echo ""
echo "[4/4] Packaging Desktop App ($PLATFORM)..."
if [ "$PLATFORM" = "mac" ]; then
  npm run pack:mac
elif [ "$PLATFORM" = "win" ]; then
  npm run pack:win
elif [ "$PLATFORM" = "linux" ]; then
  npm run pack:linux
else
  echo "Error: Unknown platform '$PLATFORM'. Valid options are: mac, win, linux."
  exit 1
fi

echo ""
echo "==========================================="
echo "✅ Desktop build completed successfully!"
echo "📂 You can find the installer files in:"
echo "   $(pwd)/release/"
echo "==========================================="
