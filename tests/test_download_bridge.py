from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = ROOT / "skills" / "baidu-pan-connector" / "tools" / "bridge.py"
TOOLS_DIR = BRIDGE_PATH.parent


def load_bridge():
    # bridge.py is also an executable script and imports sibling helpers by
    # module name. Make the test independent of the caller's PYTHONPATH.
    if str(TOOLS_DIR) not in sys.path:
        sys.path.insert(0, str(TOOLS_DIR))
    spec = importlib.util.spec_from_file_location("baidu_pan_bridge_download_test", BRIDGE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_download_is_written_to_a_partial_then_atomically_completed(tmp_path: Path) -> None:
    bridge = load_bridge()
    content = b"first chunk-second chunk"
    target = tmp_path / "nested" / "download.bin"
    registered = bridge.register_download(
        str(target),
        expected_size=len(content),
        expected_md5=hashlib.md5(content).hexdigest(),
    )

    assert not target.exists()
    first = content[:11]
    assert bridge.write_download_chunk(registered["token"], 0, first)["written"] == len(first)
    assert not target.exists()
    assert (
        bridge.write_download_chunk(registered["token"], len(first), content[len(first) :])[
            "written"
        ]
        == len(content)
    )

    completed = bridge.complete_download(registered["token"])
    assert completed["path"] == str(target.resolve())
    assert completed["size"] == len(content)
    assert completed["md5"] == hashlib.md5(content).hexdigest()
    assert target.read_bytes() == content
    assert not list(target.parent.glob("*.part"))


def test_download_rejects_bad_offsets_and_size_mismatch(tmp_path: Path) -> None:
    bridge = load_bridge()
    target = tmp_path / "download.bin"
    registered = bridge.register_download(str(target), expected_size=4)
    token = registered["token"]

    with pytest.raises(ValueError, match="offset mismatch"):
        bridge.write_download_chunk(token, 1, b"a")
    bridge.write_download_chunk(token, 0, b"abc")
    with pytest.raises(ValueError, match="size mismatch"):
        bridge.complete_download(token)

    assert not target.exists()
    aborted = bridge.abort_download(token)
    assert aborted["removed"] is True
    assert not list(tmp_path.glob("*.part"))


def test_download_ondup_policy_preserves_or_replaces_existing_file(tmp_path: Path) -> None:
    bridge = load_bridge()
    target = tmp_path / "download.bin"
    target.write_bytes(b"old")

    with pytest.raises(FileExistsError, match="already exists"):
        bridge.register_download(str(target), expected_size=3, ondup="fail")

    registered = bridge.register_download(str(target), expected_size=3, ondup="overwrite")
    bridge.write_download_chunk(registered["token"], 0, b"new")
    bridge.complete_download(registered["token"])
    assert target.read_bytes() == b"new"


def test_download_requires_an_absolute_local_target(tmp_path: Path) -> None:
    bridge = load_bridge()
    with pytest.raises(ValueError, match="must be absolute"):
        bridge.register_download("relative/file.bin", expected_size=0)


def test_native_download_is_imported_from_connector_staging(tmp_path: Path) -> None:
    bridge = load_bridge()
    content = b"chrome native download"
    target = tmp_path / "library" / "book.pdf"
    registered = bridge.register_download(
        str(target),
        expected_size=len(content),
        expected_md5=hashlib.md5(content).hexdigest(),
    )
    staging = tmp_path / "Downloads" / "baidu-pan-connector"
    staging.mkdir(parents=True)
    source = staging / f"{registered['token']}.download"
    source.write_bytes(content)

    completed = bridge.import_native_download(registered["token"], str(source))

    assert completed["path"] == str(target.resolve())
    assert completed["size"] == len(content)
    assert completed["md5"] == hashlib.md5(content).hexdigest()
    assert target.read_bytes() == content
    assert not source.exists()


def test_native_download_accepts_custom_chrome_download_root(tmp_path: Path) -> None:
    bridge = load_bridge()
    target = tmp_path / "book.pdf"
    registered = bridge.register_download(str(target), expected_size=4)
    source = tmp_path / f"{registered['token']}.download"
    source.write_bytes(b"data")

    completed = bridge.import_native_download(registered["token"], str(source))

    assert completed["path"] == str(target.resolve())
    assert target.read_bytes() == b"data"
    assert completed["source_removed"] is True
    assert not source.exists()


def test_native_download_accepts_content_disposition_name_with_md5(tmp_path: Path) -> None:
    bridge = load_bridge()
    content = b"data"
    target = tmp_path / "library" / "book.pdf"
    registered = bridge.register_download(
        str(target),
        expected_size=len(content),
        expected_md5=hashlib.md5(content).hexdigest(),
    )
    source = tmp_path / "server-provided-name.pdf"
    source.write_bytes(content)

    completed = bridge.import_native_download(registered["token"], str(source))

    assert completed["md5"] == hashlib.md5(content).hexdigest()
    assert target.read_bytes() == content
    assert completed["source_removed"] is True
    assert not source.exists()


def test_native_download_accepts_fresh_content_disposition_name_without_md5(
    tmp_path: Path,
) -> None:
    bridge = load_bridge()
    content = b"data"
    target = tmp_path / "library" / "book.pdf"
    registered = bridge.register_download(str(target), expected_size=len(content))
    source = tmp_path / "server-provided-name.pdf"
    source.write_bytes(content)

    completed = bridge.import_native_download(registered["token"], str(source))

    assert completed["md5"] == hashlib.md5(content).hexdigest()
    assert target.read_bytes() == content
    assert completed["source_removed"] is True
    assert not source.exists()


def test_native_download_rejects_stale_source_not_bound_to_token(tmp_path: Path) -> None:
    bridge = load_bridge()
    target = tmp_path / "book.pdf"
    registered = bridge.register_download(str(target), expected_size=4)
    source = tmp_path / "other.download"
    source.write_bytes(b"data")
    old_timestamp = source.stat().st_mtime - 10
    os.utime(source, (old_timestamp, old_timestamp))

    with pytest.raises(ValueError, match="neither token-named nor bound by fresh size"):
        bridge.import_native_download(registered["token"], str(source))
    bridge.abort_download(registered["token"])


def test_download_http_protocol_round_trip(tmp_path: Path) -> None:
    bridge = load_bridge()
    target = tmp_path / "http.bin"
    server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        body = json.dumps(
            {"local": str(target), "size": 4, "md5": hashlib.md5(b"data").hexdigest()}
        ).encode("utf-8")
        request = urllib.request.Request(
            base + "/download/register",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        registered = json.loads(urllib.request.urlopen(request).read().decode("utf-8"))

        request = urllib.request.Request(
            base + f"/download/{registered['token']}?offset=0",
            data=b"data",
            headers={"Content-Type": "application/octet-stream"},
            method="PUT",
        )
        written = json.loads(urllib.request.urlopen(request).read().decode("utf-8"))
        assert written["written"] == 4

        request = urllib.request.Request(
            base + f"/download/{registered['token']}/complete",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        completed = json.loads(urllib.request.urlopen(request).read().decode("utf-8"))
        assert completed["path"] == str(target.resolve())
        assert target.read_bytes() == b"data"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
