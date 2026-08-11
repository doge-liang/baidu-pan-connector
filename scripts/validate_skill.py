#!/usr/bin/env python3
"""Validate skill metadata, source layout, and runtime/source separation."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "baidu-pan-connector"


def fail(message: str) -> None:
    raise SystemExit(message)


def main() -> None:
    skill_text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", skill_text, flags=re.DOTALL)
    if not match:
        fail("SKILL.md frontmatter is missing")
    metadata = yaml.safe_load(match.group(1))
    if set(metadata) != {"name", "description"}:
        fail(f"unexpected SKILL.md fields: {sorted(set(metadata) - {'name', 'description'})}")
    if metadata["name"] != "baidu-pan-connector":
        fail("unexpected skill name")
    if not str(metadata["description"]).strip():
        fail("skill description is empty")

    version = (SKILL / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        fail(f"invalid skill version: {version}")
    manifest = json.loads((SKILL / "extension" / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        fail("extension must use Manifest V3")

    required = [
        "tools/bridge.py",
        "tools/runtime_paths.py",
        "scripts/check_install.py",
        "scripts/start_connector.ps1",
        "scripts/sync_install.py",
        "agents/openai.yaml",
    ]
    missing = [path for path in required if not (SKILL / path).is_file()]
    if missing:
        fail(f"required files missing: {missing}")

    searchable = [
        path
        for path in SKILL.rglob("*")
        if path.is_file()
        and path.suffix.lower() in {".md", ".py", ".ps1", ".js", ".json", ".yaml", ".yml"}
        and not any(part in {"dist", "__pycache__"} for part in path.parts)
    ]
    for path in searchable:
        text = path.read_text(encoding="utf-8")
        if re.search(r"(?:tools[\\/]|/tools/)connector\.py", text):
            fail(f"stale nonexistent connector.py reference: {path}")

    tracked = subprocess.check_output(
        ["git", "ls-files", "skills/baidu-pan-connector"], cwd=ROOT, text=True
    ).splitlines()
    forbidden = [
        path
        for path in tracked
        if re.search(r"(^|/)(state|__pycache__|dist)(/|$)|\.pyc$|\.log$", path)
    ]
    real_tasks = [
        path
        for path in tracked
        if "/tasks/" in path
        and Path(path).name
        not in {
            ".gitkeep",
            "example-mkdir.json",
            "example-upload.json",
            "example-download.json",
        }
    ]
    if forbidden or real_tasks:
        fail(f"runtime/generated files are tracked: {forbidden + real_tasks}")
    print(f"skill {version}, extension {manifest['version']}: validation passed")


if __name__ == "__main__":
    main()
