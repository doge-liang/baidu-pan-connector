#!/usr/bin/env python3
"""Baidu Pan Connector — install / readiness check.

Run from anywhere:
  python ~/.codex/skills/baidu-pan-connector/scripts/check_install.py
  python %USERPROFILE%\\.codex\\skills\\baidu-pan-connector\\scripts\\check_install.py

Exit codes:
  0  all required checks passed (bridge + optional pan tab may still warn)
  1  required check failed
  2  usage / internal error
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
EXT = SKILL_ROOT / "extension"
TOOLS = SKILL_ROOT / "tools"
sys.path.insert(0, str(TOOLS))

from runtime_paths import ensure_runtime_dirs, runtime_root  # noqa: E402

RUNTIME_ROOT = runtime_root()
BRIDGE = "http://127.0.0.1:27865"

REQUIRED_EXT = [
    "manifest.json",
    "background.js",
    "content.js",
    "crawl.js",
    "popup.html",
    "popup.js",
    "panel.css",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
]
REQUIRED_TOOLS = ["bridge.py", "pan_task.py", "pan_query.py"]


def ok(msg: str) -> None:
    print(f"  [OK]  {msg}")


def warn(msg: str) -> None:
    print(f"  [!!]  {msg}")


def fail(msg: str) -> None:
    print(f"  [FAIL] {msg}")


def http_get(url: str, timeout: float = 5.0) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"_error": str(e)}


def main() -> int:
    print("Baidu Pan Agent Connector — install check")
    print(f"Skill root: {SKILL_ROOT}")
    print(f"Runtime root: {RUNTIME_ROOT}")
    print()

    hard_fail = False

    # --- package files ---
    print("1) Package files")
    if not EXT.is_dir():
        fail(f"extension/ missing under {SKILL_ROOT}")
        hard_fail = True
    else:
        missing = [p for p in REQUIRED_EXT if not (EXT / p).is_file()]
        if missing:
            fail("extension incomplete: " + ", ".join(missing))
            hard_fail = True
        else:
            try:
                man = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
                ok(f"extension/ present  name={man.get('name')!r}  version={man.get('version')!r}")
            except Exception as e:
                fail(f"manifest.json unreadable: {e}")
                hard_fail = True

    missing_t = [p for p in REQUIRED_TOOLS if not (TOOLS / p).is_file()]
    if missing_t:
        fail("tools incomplete: " + ", ".join(missing_t))
        hard_fail = True
    else:
        ok("tools/ bridge.py pan_task.py pan_query.py present")

    try:
        ensure_runtime_dirs(RUNTIME_ROOT)
        ok(f"runtime state is writable outside source: {RUNTIME_ROOT}")
    except Exception as e:
        fail(f"runtime state unavailable: {e}")
        hard_fail = True

    # --- python ---
    print()
    print("2) Python")
    ok(f"python {sys.version.split()[0]}  executable={sys.executable}")

    # --- chrome path hint (best effort) ---
    print()
    print("3) Chrome extension (manual step)")
    print(f"     Load unpacked directory:")
    print(f"       {EXT}")
    print("     Steps:")
    print("       1. Open chrome://extensions")
    print("       2. Enable Developer mode")
    print("       3. Load unpacked → select the path above")
    print("       4. Open https://pan.baidu.com and log in; keep the tab open")
    warn("This script cannot verify Chrome load state; do the steps once per machine.")

    # --- bridge ---
    print()
    print("4) Local bridge (127.0.0.1:27865)")
    health = http_get(f"{BRIDGE}/health", timeout=3.0)
    if health and health.get("ok"):
        ok(f"bridge health ok  keys={list(health.keys())[:8]}")
    elif health and "_error" in health:
        fail(f"bridge not reachable: {health['_error']}")
        print("     Start with:")
        print(f"       python -B \"{TOOLS / 'bridge.py'}\"")
        hard_fail = True
    else:
        fail(f"bridge health unexpected: {health}")
        hard_fail = True

    # --- pan RPC (optional but recommended) ---
    print()
    print("5) Pan tab + extension RPC (recommended)")
    if hard_fail and not (health and health.get("ok")):
        warn("skipped (bridge down)")
    else:
        try:
            body = json.dumps(
                {"op": "list", "dir": "/", "wait": True, "max": 5},
                ensure_ascii=False,
            ).encode("utf-8")
            req = urllib.request.Request(
                f"{BRIDGE}/pan/rpc",
                data=body,
                headers={"Content-Type": "application/json; charset=utf-8"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=45) as r:
                out = json.loads(r.read().decode("utf-8"))
            rpc_ok = out.get("ok") is True and out.get("status") in (None, "done")
            if rpc_ok:
                ok("pan RPC responded (tab + extension appear active)")
                # print brief
                preview = json.dumps(out, ensure_ascii=False)[:240]
                print(f"     preview: {preview}…")
            else:
                warn(f"pan RPC returned without clear ok: {json.dumps(out, ensure_ascii=False)[:200]}")
                print("     Ensure pan.baidu.com is open, logged in, extension loaded.")
        except urllib.error.HTTPError as e:
            warn(f"pan RPC HTTP {e.code}: {e.reason}")
            print("     Bridge is up but extension/tab may be missing (waiting_tab).")
        except Exception as e:
            warn(f"pan RPC failed: {e}")
            print("     Bridge is up but extension/tab may be missing.")

    print()
    print("— Summary —")
    if hard_fail:
        print("RESULT: FAIL — fix items marked [FAIL], then re-run this script.")
        print()
        print("Quick start:")
        print(f"  python -B \"{TOOLS / 'bridge.py'}\"")
        print(f"  # Chrome → Load unpacked → {EXT}")
        print("  # Open https://pan.baidu.com (logged in)")
        print(f"  python -B \"{Path(__file__).resolve()}\"")
        return 1

    print("RESULT: PASS (package + bridge). If step 5 warned, finish Chrome/tab setup.")
    print()
    print("Everyday commands:")
    print(f"  python -B \"{TOOLS / 'pan_task.py'}\" health")
    print(f"  python -B \"{TOOLS / 'pan_query.py'}\" list \"/\" --max 20")
    print(f"  python -B \"{TOOLS / 'pan_task.py'}\" push <pack.json> --auto --wait")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        raise SystemExit(2)
