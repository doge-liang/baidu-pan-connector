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
    pan_query = (SKILL / "tools" / "pan_query.py").read_text(encoding="utf-8")

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
        "panDownloadUrls",
        "getPanDownloadContext",
        "mainWorldPanDownloadContext",
        "panSign2",
        'fetch("/api/download?" + params.toString()',
        "registerDownloadViaBridge",
        "pageContextDownloadViaBackground",
        "triggerPageContextDownload",
        "nativeDownloadViaBackground",
        "downloadOne",
        'task.op === "download"',
        'op === "download"',
    ):
        assert symbol in content
    for endpoint in ("/pan/rpc/pending", "/pan/rpc/result"):
        assert endpoint in background
    for symbol in (
        "validateDownloadUrl",
        "waitForNativeDownload",
        "nativeDownloadToBridge",
        "streamDownloadToBridge",
        "DOWNLOAD_STREAM_CHUNK_BYTES",
        "onDeterminingFilename",
        "preparePageDownloadCapture",
        "awaitPageDownloadCapture",
        'msg?.type === "download-page-prepare"',
        'msg?.type === "download-page-await"',
        'msg?.type === "download-native"',
    ):
        assert symbol in background
    assert "resolvePageDownloadContextInMainWorld" in background
    assert "getPageDownloadContextFromMainWorld" in background
    assert 'world: "MAIN"' in background
    assert "window.yunData" in background
    assert '"/api/gettemplatevariable?fields="' in background
    assert 'sign: btoa(sign2(String(data.sign3), String(data.sign1)))' in background
    assert "new Function" not in background
    assert 'source: "template-variable"' in background
    assert 'method: "GET"' in content
    assert 'params.set("vip"' in content

    # The consolidated connector must have one writer across multiple Pan tabs
    # and must stop cleanly after an extension reload invalidates its context.
    assert "notifyOneTab" in background
    assert 'type: "auto-run-pack"' in background
    assert "Extension context invalidated" in content
    assert "stopForInvalidatedContext" in content
    assert "chrome.runtime.getManifest().version" in content

    # Resource safety: web-large files fail before transfer, failed auto batches
    # are terminally halted, and full task state writes are coalesced.
    assert "WEB_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024" in content
    assert "MAX_CONSECUTIVE_AUTO_FAILURES = 3" in content
    assert "rejectRemainingQueue" in content
    assert "persistInFlight" in content
    assert "persistDirty" in content
    assert "WEB_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024" in background
    assert "historyHydrated" in background
    assert '"/history?limit=50"' in background
    assert "pollBridgeInFlight" in background
    assert "path_is_within(resolved_target, runtime_root().resolve())" in pan_query


def test_connector_ui_and_permissions_remain_minimal() -> None:
    content = (EXTENSION / "content.js").read_text(encoding="utf-8")
    background = (EXTENSION / "background.js").read_text(encoding="utf-8")
    popup = (EXTENSION / "popup.html").read_text(encoding="utf-8")
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))

    assert "connector-ui-status" in content
    assert "DEBUG" in content
    for obsolete_control in ("approveAll", "rejectAll", "importJson", "clearAllPacks"):
        assert obsolete_control not in content
    assert "input" not in popup.lower()
    assert manifest["permissions"] == [
        "storage",
        "downloads",
        "declarativeNetRequestWithHostAccess",
        "scripting",
    ]
    assert "installDownloadHeaderRules" in background
    assert 'header: "Referer"' in background
    assert 'referer: "https://pan.baidu.com/disk/main"' in background
    assert 'header: "User-Agent"' in background
    assert "DOWNLOAD_WEB_USER_AGENT" in background
    assert "DOWNLOAD_HEADER_PROFILES" in background
    assert 'name: "browser"' in background
    assert 'name: "legacy-netdisk"' in background
    assert 'name: "openapi-pan"' in background
    assert 'name: "pcs-netdisk"' in background
    assert 'userAgent: "netdisk"' in background
    assert 'userAgent: "pan.baidu.com"' in background
    assert 'referer: "http://pan.baidu.com/disk/home"' in background
    assert '"netdisk;2.2.51.6;netdisk;10.0.63;PC;android-android"' in background
    assert 'resourceTypes: ["other"]' not in background
    assert '"pcs.baidu.com"' in background
    assert '"baidupcs.com"' in background
    assert "finalHost=" in background
