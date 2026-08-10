from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

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


def make_directory_link(link: Path, target: Path) -> None:
    if os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode:
            pytest.skip(f"cannot create a Windows test junction: {result.stderr}")
    else:
        link.symlink_to(target, target_is_directory=True)


def test_strict_source_link_accepts_link_and_rejects_copy(tmp_path: Path) -> None:
    source = ROOT / "skills" / "baidu-pan-connector"
    link = tmp_path / "linked-install"
    make_directory_link(link, source)

    linked = run_sync(link, "--check", "--require-source-link")
    assert linked.returncode == 0, linked.stderr

    copied = tmp_path / "copied-install"
    applied = run_sync(copied, "--apply", "--check")
    assert applied.returncode == 0, applied.stderr
    strict_copy = run_sync(copied, "--check", "--require-source-link")
    assert strict_copy.returncode == 1
    assert "does not resolve to source" in strict_copy.stderr
