from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = ROOT / "skills" / "baidu-pan-connector" / "tools" / "bridge.py"


def load_bridge():
    spec = importlib.util.spec_from_file_location("baidu_pan_bridge_rpc_test", BRIDGE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_pending_rpc_is_claimed_only_once() -> None:
    bridge = load_bridge()
    with bridge._lock:
        bridge._rpc.clear()

    first_id = bridge.enqueue_rpc("upload", {"path": "/one.pdf"})
    second_id = bridge.enqueue_rpc("list", {"dir": "/"})

    first_claim = bridge.claim_pending_rpcs()
    second_claim = bridge.claim_pending_rpcs()

    assert {item["id"] for item in first_claim} == {first_id, second_id}
    assert second_claim == []
    with bridge._lock:
        assert bridge._rpc[first_id]["status"] == "dispatching"
        assert bridge._rpc[second_id]["status"] == "dispatching"


def test_first_terminal_rpc_result_wins() -> None:
    bridge = load_bridge()
    with bridge._lock:
        bridge._rpc.clear()

    rid = bridge.enqueue_rpc("upload", {"path": "/one.pdf"})
    assert [item["id"] for item in bridge.claim_pending_rpcs()] == [rid]

    first = bridge.record_rpc_result(rid, ok=True, result={"path": "/one.pdf"})
    late = bridge.record_rpc_result(rid, ok=False, error="late duplicate")

    assert first == {"found": True, "accepted": True, "status": "done"}
    assert late == {"found": True, "accepted": False, "status": "done"}
    with bridge._lock:
        assert bridge._rpc[rid]["result"] == {"path": "/one.pdf"}
        assert bridge._rpc[rid]["error"] is None
