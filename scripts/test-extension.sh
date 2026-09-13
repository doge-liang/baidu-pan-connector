#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

EXT=skills/baidu-pan-connector/extension
PYTHON_BIN=${PYTHON_BIN:-python3}
for file in background.js content.js crawl.js popup.js; do
  node --check "$EXT/$file"
done

node - "$EXT/manifest.json" <<'NODE'
const fs = require('fs');
const path = require('path');
const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const permissions = manifest.permissions || [];
if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('version must be x.y.z');
if (
  permissions.length !== 4 ||
  permissions[0] !== 'storage' ||
  permissions[1] !== 'downloads' ||
  permissions[2] !== 'declarativeNetRequestWithHostAccess' ||
  permissions[3] !== 'scripting'
) {
  throw new Error(`unexpected permissions: ${JSON.stringify(permissions)}`);
}
for (const size of ['16', '48', '128']) {
  const icon = manifest.icons && manifest.icons[size];
  if (!icon || !fs.existsSync(path.join(path.dirname(manifestPath), icon))) {
    throw new Error(`missing ${size}px icon`);
  }
}
process.stdout.write(`manifest ${manifest.version}: ok\n`);
NODE

if grep -Eq '\b(confirm|prompt)\s*\(' "$EXT/content.js"; then
  echo "Interactive confirm/prompt calls are forbidden in Connector UI" >&2
  exit 1
fi
if grep -Eq '<button\b' "$EXT/popup.html"; then
  echo "Connector popup must remain status-only" >&2
  exit 1
fi
grep -q 'safeRuntimeSendMessage' "$EXT/content.js"
grep -q '扩展已重载，请刷新百度网盘页面' "$EXT/content.js"

PYTHONDONTWRITEBYTECODE=1 "$PYTHON_BIN" "$EXT/store/pack.py"
PYTHONDONTWRITEBYTECODE=1 "$PYTHON_BIN" - "$EXT" <<'PY'
import json
import sys
import zipfile
from pathlib import Path

extension = Path(sys.argv[1])
manifest = json.loads((extension / "manifest.json").read_text(encoding="utf-8"))
archive = extension / "dist" / f"baidu-pan-agent-connector-{manifest['version']}.zip"
required = {
    "manifest.json", "background.js", "content.js", "crawl.js", "panel.css",
    "popup.html", "popup.js", "icons/icon16.png", "icons/icon48.png",
    "icons/icon128.png", "icons/LICENSE-lucide.txt",
}
with zipfile.ZipFile(archive) as package:
    entries = set(package.namelist())
missing = required - entries
if missing:
    raise SystemExit(f"package missing: {sorted(missing)}")
for forbidden in ("tasks/", "store/", "__pycache__/"):
    if any(name.startswith(forbidden) for name in entries):
        raise SystemExit(f"package contains forbidden path: {forbidden}")
print(f"package {archive.name}: {len(entries)} entries, ok")
PY
