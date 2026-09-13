from __future__ import annotations

import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1] / "skills" / "baidu-pan-connector" / "tools"
sys.path.insert(0, str(TOOLS))

import runtime_paths
import pan_query


def test_explicit_runtime_root_and_directories(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "runtime"
    monkeypatch.setenv(runtime_paths.STATE_ENV, str(root))
    assert runtime_paths.runtime_root() == root.resolve()
    paths = runtime_paths.ensure_runtime_dirs()
    assert paths["tasks"].is_dir()
    assert paths["logs"].is_dir()
    assert paths["crawl_cache"].is_dir()
    assert paths["python_cache"].is_dir()
    assert paths["index_out"].is_dir()


def test_relative_runtime_root_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(runtime_paths.STATE_ENV, "relative/runtime")
    with pytest.raises(ValueError, match="absolute path"):
        runtime_paths.runtime_root()


def test_download_target_containment_check(tmp_path: Path) -> None:
    state = (tmp_path / "state").resolve()
    assert pan_query.path_is_within(state / "workspace" / "file.bin", state)
    assert not pan_query.path_is_within((tmp_path / "downloads" / "file.bin").resolve(), state)
