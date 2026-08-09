#!/usr/bin/env python3
"""Resolve Baidu Pan Connector runtime paths outside the source tree."""

from __future__ import annotations

import os
from pathlib import Path

STATE_ENV = "BAIDU_PAN_CONNECTOR_STATE_DIR"


def codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".codex"


def runtime_root() -> Path:
    configured = os.environ.get(STATE_ENV, "").strip()
    root = Path(configured).expanduser() if configured else codex_home() / "state" / "baidu-pan-connector"
    if not root.is_absolute():
        raise ValueError(f"{STATE_ENV} must be an absolute path: {root}")
    return root.resolve(strict=False)


def ensure_runtime_dirs(root: Path | None = None) -> dict[str, Path]:
    base = root or runtime_root()
    paths = {
        "root": base,
        "tasks": base / "tasks",
        "logs": base / "logs",
        "crawl_cache": base / "cache" / "crawl",
        "python_cache": base / "cache" / "python",
        "index_out": base / "index-out",
    }
    for path in paths.values():
        path.mkdir(parents=True, exist_ok=True)
    return paths
