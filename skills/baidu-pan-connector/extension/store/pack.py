#!/usr/bin/env python3
"""Build a Chrome Web Store zip: extension runtime only (no tasks/, no store drafts)."""
from __future__ import annotations

import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"

# Only ship runtime + icons. Never ship personal task packs or store drafting files.
INCLUDE_FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "crawl.js",
    "panel.css",
    "popup.html",
    "popup.js",
]
INCLUDE_GLOBS = [
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
    "icons/LICENSE-lucide.txt",
]


def main() -> None:
    DIST.mkdir(parents=True, exist_ok=True)
    ver = "0.0.0"
    try:
        import json

        ver = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8")).get(
            "version", ver
        )
    except Exception:
        pass
    out = DIST / f"baidu-pan-agent-connector-{ver}.zip"
    if out.exists():
        out.unlink()

    files: list[Path] = []
    for rel in INCLUDE_FILES:
        p = ROOT / rel
        if not p.is_file():
            raise SystemExit(f"missing required file: {rel}")
        files.append(p)
    for rel in INCLUDE_GLOBS:
        p = ROOT / rel
        if not p.is_file():
            raise SystemExit(f"missing required asset: {rel}")
        files.append(p)

    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in files:
            arc = p.relative_to(ROOT).as_posix()
            # Chrome rejects package entries whose path segments start with "_"
            if any(part.startswith("_") for part in Path(arc).parts):
                raise SystemExit(f"refusing underscore path in package: {arc}")
            zf.write(p, arcname=arc)
            print(" +", arc)

    size_kb = out.stat().st_size / 1024
    print(f"wrote {out} ({size_kb:.1f} KiB)  [{date.today().isoformat()}]")
    print("Upload this zip in Chrome Web Store Developer Dashboard → package.")


if __name__ == "__main__":
    main()
