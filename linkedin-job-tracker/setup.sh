#!/usr/bin/env bash
# All vendor libraries are committed to the repo — no download needed.
# To update a library to a newer version, run the relevant curl command below
# and commit the updated file.
#
# pdf.js 3.11.174:
#   curl -fsSL "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" -o pdf.min.js
#   curl -fsSL "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js" -o pdf.worker.min.js
#
# SheetJS 0.20.3:
#   curl -fsSL "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js" -o xlsx.mini.min.js
#
# JSZip 3.10.1:
#   curl -fsSL "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js" -o jszip.min.js
#
# Mammoth 1.8.0:
#   curl -fsSL "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js" -o mammoth.browser.min.js

echo "Nothing to do — vendor libraries are already bundled."
echo "Load the extension in Chrome:"
echo "  1. Open chrome://extensions"
echo "  2. Enable Developer mode (top-right toggle)"
echo "  3. Click 'Load unpacked' and select: $(cd "$(dirname "$0")" && pwd)"
