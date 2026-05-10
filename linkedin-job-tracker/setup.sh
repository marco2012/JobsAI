#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "Downloading SheetJS (xlsx.mini.min.js)..."
curl -fsSL "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js" -o xlsx.mini.min.js
echo "Done. File size: $(du -sh xlsx.mini.min.js | cut -f1)"

echo ""
echo "Setup complete. Load the extension in Chrome:"
echo "  1. Open chrome://extensions"
echo "  2. Enable Developer mode (top-right toggle)"
echo "  3. Click 'Load unpacked' and select this folder:"
echo "     $DIR"
