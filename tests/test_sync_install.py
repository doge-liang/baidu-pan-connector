from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills" / "baidu-pan-connector" / "scripts" / "sync_install.py"


def run_sync(target: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-B", str(SCRIPT), "--install-dir", str(target), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_deploy_and_detect_drift(tmp_path: Path) -> None:
    target = tmp_path / "installed"
    applied = run_sync(target, "--apply", "--check")
    assert applied.returncode == 0, applied.stderr

    manifest = target / "extension" / "manifest.json"
    manifest.write_text("{}\n", encoding="utf-8")
    drift = run_sync(target, "--check")
    assert drift.returncode == 1
    assert "content differs: extension/manifest.json" in drift.stderr
