from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "baidu-pan-connector"
EXTENSION = SKILL / "extension"


def test_three_source_semantic_contract_is_preserved() -> None:
    """Guard the union of the legacy extension and installed-skill features."""

    content = (EXTENSION / "content.js").read_text(encoding="utf-8")
    background = (EXTENSION / "background.js").read_text(encoding="utf-8")

    # Core task operations originated in the Knowledge extension copy.
    for operation in (
        "mkdir",
        "copy",
        "copy-batch",
        "delete",
        "rename",
        "move",
        "normalize-dir",
    ):
        assert f'task.op === "{operation}"' in content

    # Local upload and live RPC originated in the installed Skill copy.
    for symbol in (
        "registerLocalViaBridge",
        "fetchLocalChunk",
        "panPrecreate",
        "panUploadPart",
        "panCreateFile",
        "uploadOne",
        'task.op === "upload"',
        'op === "upload"',
    ):
        assert symbol in content
    for endpoint in ("/pan/rpc/pending", "/pan/rpc/result"):
        assert endpoint in background

    # The consolidated connector must have one writer across multiple Pan tabs
    # and must stop cleanly after an extension reload invalidates its context.
    assert "notifyOneTab" in background
    assert 'type: "auto-run-pack"' in background
    assert "Extension context invalidated" in content
    assert "stopForInvalidatedContext" in content


def test_connector_ui_and_permissions_remain_minimal() -> None:
    content = (EXTENSION / "content.js").read_text(encoding="utf-8")
    popup = (EXTENSION / "popup.html").read_text(encoding="utf-8")
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))

    assert "connector-ui-status" in content
    assert "DEBUG" in content
    for obsolete_control in ("approveAll", "rejectAll", "importJson", "clearAllPacks"):
        assert obsolete_control not in content
    assert "input" not in popup.lower()
    assert manifest["permissions"] == ["storage"]
