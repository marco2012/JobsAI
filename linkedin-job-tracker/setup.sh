#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "Downloading SheetJS (xlsx.mini.min.js)..."
curl -fsSL "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js" -o xlsx.mini.min.js
echo "Done. File size: $(du -sh xlsx.mini.min.js | cut -f1)"

echo ""
echo "Downloading pdf.js (pdf.min.js + pdf.worker.min.js)..."
curl -fsSL "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" -o pdf.min.js
echo "Done. File size: $(du -sh pdf.min.js | cut -f1)"
curl -fsSL "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js" -o pdf.worker.min.js
echo "Done. File size: $(du -sh pdf.worker.min.js | cut -f1)"

echo ""
echo "Setup complete. Load the extension in Chrome:"
echo "  1. Open chrome://extensions"
echo "  2. Enable Developer mode (top-right toggle)"
echo "  3. Click 'Load unpacked' and select this folder:"
echo "     $DIR"
