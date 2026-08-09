#!/usr/bin/env python3
"""本机任务桥 + 抓取落盘 + 索引重建 + 自动执行状态。

默认监听 127.0.0.1:27865。只接受本机回环，不写 bdstoken / Cookie。
# 注：17865 常落在 Windows Hyper-V/WSL 动态保留段（约 14k–18k）内导致 bind 10013。

用法（Python 工具不得放进扩展目录）:
  python -B tools/bridge.py
  python -B tools/pan_task.py push <runtime>/tasks/xxx.json --auto --wait

扩展端点:
  GET  /health /pending /history /index/status /run/status
  POST /push /ack /drop /run/result
  POST /crawl/upload   body = baidu-pan-crawl.json 全文
  POST /index/rebuild  用已上传 crawl 跑 baidu-pan-index.py

push 体可带 auto=true + auto_policy：扩展 connector 模式自动核准并执行，CLI 轮询 /run/status。
"""

from __future__ import annotations

# 禁止在扩展目录生成 __pycache__（Chrome 拒绝加载含 _ 前缀路径的扩展）
import sys

sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import mimetypes
import secrets
import subprocess
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

from runtime_paths import ensure_runtime_dirs, runtime_root

HOST = "127.0.0.1"
PORT = 27865

import os

# Skill layout:  …/baidu-pan-connector/tools/bridge.py
# Runtime data:  BAIDU_PAN_CONNECTOR_STATE_DIR or ~/.codex/state/baidu-pan-connector
# Optional vault (for index rebuild only): env BAIDU_PAN_VAULT or KNOWLEDGE_VAULT
_TOOLS_DIR = Path(__file__).resolve().parent
_SKILL_ROOT = _TOOLS_DIR.parent
_vault_env = (
    os.environ.get("BAIDU_PAN_VAULT") or os.environ.get("KNOWLEDGE_VAULT") or ""
).strip()
_VAULT: Path | None
if _vault_env:
    _cand = Path(_vault_env).expanduser().resolve()
    _VAULT = _cand if _cand.is_dir() else None
elif _TOOLS_DIR.name == "baidu-pan-tools" and _TOOLS_DIR.parent.name == "scripts":
    # Legacy repo layout: scripts/baidu-pan-tools → vault root
    _VAULT = _TOOLS_DIR.parents[1]
else:
    _VAULT = None  # index rebuild needs --vault or env
_INDEX_PY = (
    (_VAULT / "scripts" / "baidu-pan-index.py") if _VAULT is not None else Path()
)
_RUNTIME_ROOT = runtime_root()
_RUNTIME_PATHS = ensure_runtime_dirs(_RUNTIME_ROOT)
_OUT = (
    (_VAULT / "5-External" / "baidu-pan")
    if _VAULT is not None
    else _RUNTIME_PATHS["index_out"]
)
# State/cache remain outside the source and extension trees.
_CACHE_DIR = _RUNTIME_PATHS["crawl_cache"]
_CRAWL_JSON = _CACHE_DIR / "baidu-pan-crawl.json"
_STATE_DIR = _RUNTIME_ROOT
_STATE_FILE = _STATE_DIR / "packs.json"

_lock = threading.Lock()
_pending: dict[str, dict[str, Any]] = {}
_history: dict[str, dict[str, Any]] = {}
_index_status: dict[str, Any] = {
    "idle": True,
    "running": False,
    "last": None,
}
# pack_id → 自动执行进度（扩展回写）
_runs: dict[str, dict[str, Any]] = {}
# 扩展实况查询 RPC：agent → bridge 排队 → 扩展在 pan 页执行 → 回写结果
_rpc_seq = 0
_rpc: dict[str, dict[str, Any]] = {}
_RPC_TTL_SEC = 180

# 本机文件暂存：供扩展 fetch 后走网盘网页上传 API（扩展无本地盘权限）
# token → { path, name, size, content_md5, block_list, block_size, created }
_local_files: dict[str, dict[str, Any]] = {}
_LOCAL_TTL_SEC = 3600
_LOCAL_MAX_BYTES = int(os.environ.get("BAIDU_PAN_UPLOAD_MAX_BYTES") or (8 * 1024**3))  # 8 GiB
_BLOCK_SIZE = 4 * 1024 * 1024  # 网盘网页端分块 4MiB


def _purge_local_files_unlocked() -> None:
    now = time.time()
    dead = [
        t
        for t, m in _local_files.items()
        if now - float(m.get("created") or 0) > _LOCAL_TTL_SEC
    ]
    for t in dead:
        _local_files.pop(t, None)


def hash_local_file(path: Path) -> dict[str, Any]:
    """Compute content-md5 + 4MiB block md5 list for pan precreate."""
    size = path.stat().st_size
    if size > _LOCAL_MAX_BYTES:
        raise ValueError(
            f"file too large: {size} > max {_LOCAL_MAX_BYTES} "
            f"(set BAIDU_PAN_UPLOAD_MAX_BYTES to raise)"
        )
    blocks: list[str] = []
    h_all = hashlib.md5()
    h_slice = hashlib.md5()
    first = True
    with path.open("rb") as f:
        while True:
            chunk = f.read(_BLOCK_SIZE)
            if not chunk:
                break
            h_all.update(chunk)
            blocks.append(hashlib.md5(chunk).hexdigest())
            if first:
                h_slice.update(chunk)
                first = False
    if not blocks:
        # empty file
        empty = hashlib.md5(b"").hexdigest()
        blocks = [empty]
        content_md5 = empty
        slice_md5 = empty
    else:
        content_md5 = h_all.hexdigest()
        slice_md5 = h_slice.hexdigest()
    return {
        "size": size,
        "content_md5": content_md5,
        "slice_md5": slice_md5,
        "block_list": blocks,
        "block_size": _BLOCK_SIZE,
        "block_count": len(blocks),
    }


def register_local_file(local_path: str) -> dict[str, Any]:
    p = Path(local_path).expanduser().resolve()
    if not p.is_file():
        raise FileNotFoundError(f"not a file: {p}")
    # 基础路径安全：禁止空盘符乱穿；仍允许用户主目录与任意绝对路径（Agent 场景）
    if ".." in p.parts:
        raise ValueError("path must not contain .. after resolve")
    meta = hash_local_file(p)
    token = secrets.token_urlsafe(24)
    rec = {
        "token": token,
        "path": str(p),
        "name": p.name,
        "created": time.time(),
        **meta,
    }
    with _lock:
        _purge_local_files_unlocked()
        _local_files[token] = rec
    return {
        "ok": True,
        "token": token,
        "name": rec["name"],
        "path": rec["path"],
        "size": rec["size"],
        "content_md5": rec["content_md5"],
        "slice_md5": rec["slice_md5"],
        "block_list": rec["block_list"],
        "block_size": rec["block_size"],
        "block_count": rec["block_count"],
        "url": f"http://{HOST}:{PORT}/localfile/{token}",
    }


def load_pack(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "id" not in data or "tasks" not in data:
        raise ValueError("任务包须含 id 与 tasks")
    return data


def apply_auto_policy(pack: dict[str, Any], mode: str = "all") -> dict[str, Any]:
    """给 tasks 打 status=approved（CLI/agent 侧闸门；扩展 connector 只执行）。

    mode:
      all  — 全部核准（含 delete/high）
      safe — 仅 non-delete 且 risk!=high
    """
    mode = (mode or "all").lower()
    out = dict(pack)
    tasks = []
    approved = 0
    held = 0
    for t in pack.get("tasks") or []:
        tt = dict(t)
        st = tt.get("status")
        if st in ("done", "failed"):
            tasks.append(tt)
            continue
        if mode == "safe" and (
            tt.get("op") == "delete" or tt.get("risk") == "high"
        ):
            tt["status"] = "pending"
            tt["needs_human"] = True
            held += 1
        else:
            tt["status"] = "approved"
            tt.pop("needs_human", None)
            approved += 1
        tasks.append(tt)
    out["tasks"] = tasks
    out["auto"] = True
    out["auto_execute"] = True
    out["auto_policy"] = {
        "mode": mode,
        "skip_confirm": True,
        "approved": approved,
        "held_for_human": held,
    }
    out["push_seq"] = int(time.time() * 1000)
    return out


def push_pack(pack: dict[str, Any], *, auto: bool = False, mode: str = "all") -> dict[str, Any]:
    """投递任务包。auto=True 时按 mode 预核准 tasks，扩展 connector 拉取后直接执行。"""
    base = dict(pack)
    want_auto = bool(auto or base.get("auto") or base.get("auto_execute"))
    if want_auto:
        pol = base.get("auto_policy") if isinstance(base.get("auto_policy"), dict) else {}
        use_mode = mode if auto else (pol.get("mode") or mode or "all")
        # 从干净 tasks 重算核准，避免重复 push 粘住旧 status
        clean_tasks = []
        for t in base.get("tasks") or []:
            tt = dict(t)
            if tt.get("status") not in ("done",):
                tt.pop("status", None)
                tt.pop("result", None)
            clean_tasks.append(tt)
        base["tasks"] = clean_tasks
        base = apply_auto_policy(base, mode=str(use_mode))
    else:
        if "push_seq" not in base:
            base["push_seq"] = int(time.time() * 1000)
    with _lock:
        _pending[base["id"]] = base
        _history[base["id"]] = base
        _runs[base["id"]] = {
            "id": base["id"],
            "status": "queued",
            "auto": bool(base.get("auto") or base.get("auto_execute")),
            "auto_policy": base.get("auto_policy"),
            "push_seq": base.get("push_seq"),
            "tasks_total": len(base.get("tasks") or []),
            "counts": {},
            "tasks": [],
            "error": None,
            "log_tail": [],
            "updated": time.time(),
            "created": time.time(),
        }
        _save_state_unlocked()
    return base


def _save_state_unlocked() -> None:
    _STATE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "pending_ids": list(_pending.keys()),
        "history": list(_history.values()),
    }
    _STATE_FILE.write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def _load_state() -> None:
    if not _STATE_FILE.is_file():
        return
    try:
        data = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[bridge] state load failed: {e}")
        return
    hist = data.get("history") or []
    pending_ids = set(data.get("pending_ids") or [])
    with _lock:
        _history.clear()
        _pending.clear()
        for pack in hist:
            if not isinstance(pack, dict) or "id" not in pack:
                continue
            _history[pack["id"]] = pack
            if pack["id"] in pending_ids:
                _pending[pack["id"]] = pack
    print(
        f"[bridge] restored state: history={len(_history)} pending={len(_pending)} from {_STATE_FILE}"
    )


def _new_rpc_id() -> str:
    global _rpc_seq
    with _lock:
        _rpc_seq += 1
        return f"rpc-{_rpc_seq}-{int(__import__('time').time())}"


def _purge_rpc_unlocked() -> None:
    import time

    now = time.time()
    dead = [
        i
        for i, r in _rpc.items()
        if now - r.get("created", 0) > _RPC_TTL_SEC
        and r.get("status") in ("pending", "done", "error")
    ]
    # 只清超时 pending；done 多留一会给取结果
    dead = [
        i
        for i, r in _rpc.items()
        if now - r.get("created", 0) > _RPC_TTL_SEC
    ]
    for i in dead:
        _rpc.pop(i, None)


def enqueue_rpc(op: str, params: dict[str, Any]) -> str:
    import time

    rid = _new_rpc_id()
    with _lock:
        _purge_rpc_unlocked()
        _rpc[rid] = {
            "id": rid,
            "op": op,
            "params": params or {},
            "status": "pending",
            "created": time.time(),
            "result": None,
            "error": None,
        }
    return rid


def wait_rpc(rid: str, timeout_sec: float = 90.0) -> dict[str, Any]:
    import time

    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        with _lock:
            r = _rpc.get(rid)
            if not r:
                return {"ok": False, "error": "rpc not found"}
            if r["status"] in ("done", "error"):
                return {
                    "ok": r["status"] == "done",
                    "id": rid,
                    "status": r["status"],
                    "result": r.get("result"),
                    "error": r.get("error"),
                }
        time.sleep(0.25)
    return {"ok": False, "id": rid, "status": "timeout", "error": "extension did not answer in time; open pan.baidu.com with extension loaded"}


def run_index_job() -> None:
    with _lock:
        _index_status["running"] = True
        _index_status["idle"] = False
        _index_status["last"] = {"phase": "starting"}
    try:
        if not _CRAWL_JSON.is_file():
            raise FileNotFoundError(f"无抓取缓存: {_CRAWL_JSON}")
        if _VAULT is None or not _INDEX_PY.is_file():
            raise FileNotFoundError(
                "无索引脚本/vault。请设置环境变量 BAIDU_PAN_VAULT，"
                f"或 bridge --vault <root>。当前 index={_INDEX_PY}"
            )
        _OUT.mkdir(parents=True, exist_ok=True)
        cmd = [
            sys.executable,
            str(_INDEX_PY),
            "--raw",
            str(_CRAWL_JSON),
            "--out",
            str(_OUT),
        ]
        proc = subprocess.run(
            cmd,
            cwd=str(_VAULT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )
        result = {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "cmd": cmd,
            "stdout_tail": (proc.stdout or "")[-4000:],
            "stderr_tail": (proc.stderr or "")[-4000:],
            "crawl": str(_CRAWL_JSON),
            "out": str(_OUT),
        }
        # 尝试读 stats
        stats_path = _OUT / "_data" / "stats.json"
        if stats_path.is_file():
            try:
                result["stats"] = json.loads(stats_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        with _lock:
            _index_status["last"] = result
    except Exception as e:
        with _lock:
            _index_status["last"] = {
                "ok": False,
                "error": str(e),
                "trace": traceback.format_exc()[-2000:],
            }
    finally:
        with _lock:
            _index_status["running"] = False
            _index_status["idle"] = True


class Handler(BaseHTTPRequestHandler):
    # 抓取 JSON 可达数十 MB
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        print("[bridge]", self.address_string(), "-", fmt % args)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, obj: Any) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/", "/health"):
            with _lock:
                n = len(_pending)
                idx = dict(_index_status)
                runs_n = len(_runs)
                auto_running = sum(
                    1
                    for r in _runs.values()
                    if r.get("status") in ("queued", "imported", "running")
                )
            self._json(
                200,
                {
                    "ok": True,
                    "pending": n,
                    "runs": runs_n,
                    "auto_running": auto_running,
                    "vault": str(_VAULT) if _VAULT is not None else None,
                    "crawl_cached": _CRAWL_JSON.is_file(),
                    "crawl_bytes": _CRAWL_JSON.stat().st_size if _CRAWL_JSON.is_file() else 0,
                    "index": {
                        "running": idx.get("running"),
                        "idle": idx.get("idle"),
                        "last_ok": (idx.get("last") or {}).get("ok"),
                    },
                },
            )
            return
        if path == "/run/status":
            qs = parse_qs(urlparse(self.path).query)
            rid = (qs.get("id") or [""])[0]
            with _lock:
                if rid:
                    r = _runs.get(rid)
                    if not r:
                        self._json(404, {"error": "run not found", "id": rid})
                        return
                    self._json(200, {"ok": True, "run": r})
                    return
                self._json(
                    200,
                    {
                        "ok": True,
                        "runs": list(_runs.values()),
                    },
                )
            return
        if path == "/pending":
            with _lock:
                packs = list(_pending.values())
            self._json(200, {"packs": packs})
            return
        if path == "/history":
            with _lock:
                packs = list(_history.values())
            self._json(200, {"packs": packs})
            return
        if path == "/index/status":
            with _lock:
                st = {
                    "running": _index_status["running"],
                    "idle": _index_status["idle"],
                    "last": _index_status["last"],
                    "crawl_cached": _CRAWL_JSON.is_file(),
                    "crawl_bytes": _CRAWL_JSON.stat().st_size if _CRAWL_JSON.is_file() else 0,
                    "out": str(_OUT),
                }
            self._json(200, st)
            return
        # —— 本机文件：扩展拉取后上传到网盘 ——
        if path.startswith("/localfile/"):
            token = path[len("/localfile/") :].strip("/")
            if not token or token in ("register", "meta"):
                self._json(404, {"error": "use POST /localfile/register"})
                return
            qs = parse_qs(urlparse(self.path).query)
            with _lock:
                _purge_local_files_unlocked()
                rec = _local_files.get(token)
            if not rec:
                self._json(404, {"error": "token not found or expired"})
                return
            fp = Path(rec["path"])
            if not fp.is_file():
                self._json(404, {"error": "file missing on disk", "path": str(fp)})
                return
            size = int(rec["size"])
            # optional Range / offset+length for chunked upload
            offset = int((qs.get("offset") or ["0"])[0])
            length_q = (qs.get("length") or [""])[0]
            length = int(length_q) if length_q else (size - offset)
            if offset < 0 or offset > size:
                self._json(400, {"error": "bad offset"})
                return
            length = max(0, min(length, size - offset))
            try:
                with fp.open("rb") as f:
                    f.seek(offset)
                    data = f.read(length)
            except OSError as e:
                self._json(500, {"error": str(e)})
                return
            mime = mimetypes.guess_type(fp.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            # BaseHTTPRequestHandler encodes response headers as Latin-1. Raw
            # Chinese filenames therefore terminate the connection before the
            # binary body is sent. Preserve the metadata using RFC 3986-safe
            # percent encoding; upload clients do not otherwise depend on it.
            self.send_header("X-File-Name", quote(rec["name"], safe=""))
            self.send_header("X-File-Size", str(size))
            self.send_header("X-Content-MD5", rec["content_md5"])
            self._cors()
            self.end_headers()
            self.wfile.write(data)
            return
        # —— 实况查询（扩展代理 pan API）——
        if path == "/pan/rpc/pending":
            with _lock:
                _purge_rpc_unlocked()
                pending = [
                    {
                        "id": r["id"],
                        "op": r["op"],
                        "params": r["params"],
                        "created": r["created"],
                    }
                    for r in _rpc.values()
                    if r["status"] == "pending"
                ]
            self._json(200, {"requests": pending})
            return
        if path.startswith("/pan/rpc/"):
            rid = path[len("/pan/rpc/") :].strip("/")
            if not rid or rid == "pending":
                self._json(404, {"error": "not found"})
                return
            with _lock:
                r = _rpc.get(rid)
                if not r:
                    self._json(404, {"error": "rpc not found", "id": rid})
                    return
                self._json(
                    200,
                    {
                        "ok": r["status"] == "done",
                        "id": rid,
                        "status": r["status"],
                        "result": r.get("result"),
                        "error": r.get("error"),
                        "op": r.get("op"),
                    },
                )
            return
        # 便捷：GET /pan/list?dir=/path&wait=1  同步等扩展（默认 wait=1）
        if path == "/pan/list":
            qs = parse_qs(urlparse(self.path).query)
            dir_path = (qs.get("dir") or ["/"])[0]
            wait = (qs.get("wait") or ["1"])[0] != "0"
            recursive = (qs.get("recursive") or ["0"])[0] == "1"
            max_entries = int((qs.get("max") or ["2000"])[0])
            rid = enqueue_rpc(
                "list",
                {
                    "dir": dir_path,
                    "recursive": recursive,
                    "max_entries": max_entries,
                },
            )
            if not wait:
                self._json(200, {"ok": True, "id": rid, "status": "pending"})
                return
            self._json(200, wait_rpc(rid, timeout_sec=90.0))
            return
        if path == "/pan/exists":
            qs = parse_qs(urlparse(self.path).query)
            target = (qs.get("path") or [""])[0]
            if not target:
                self._json(400, {"error": "path required"})
                return
            rid = enqueue_rpc("exists", {"path": target})
            self._json(200, wait_rpc(rid, timeout_sec=60.0))
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if path == "/crawl/upload":
            # body 必须是完整 crawl JSON（可能很大）
            try:
                data = json.loads(raw.decode("utf-8") if raw else "{}")
            except json.JSONDecodeError as e:
                self._json(400, {"error": "invalid json: " + str(e)})
                return
            if "rows" not in data or "columns" not in data:
                self._json(400, {"error": "not a crawl payload (need columns+rows)"})
                return
            _CACHE_DIR.mkdir(parents=True, exist_ok=True)
            if raw:
                _CRAWL_JSON.write_bytes(raw)
            else:
                _CRAWL_JSON.write_text(
                    json.dumps(data, ensure_ascii=False), encoding="utf-8"
                )
            n_rows = len(data.get("rows") or [])
            self._json(
                200,
                {
                    "ok": True,
                    "path": str(_CRAWL_JSON),
                    "bytes": _CRAWL_JSON.stat().st_size,
                    "rows": n_rows,
                    "total": data.get("total"),
                    "dirs": data.get("dirs"),
                    "md5_missing": data.get("md5_missing"),
                    "generated_at": data.get("generated_at"),
                },
            )
            return

        # 以下 endpoint 用 JSON 小对象
        try:
            data = json.loads(raw.decode("utf-8") or "{}") if raw else {}
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return

        if path in ("/localfile/register", "/localfile/meta"):
            local = data.get("path") or data.get("local") or ""
            if not local:
                self._json(400, {"error": "path required (local absolute file path)"})
                return
            try:
                info = register_local_file(str(local))
            except FileNotFoundError as e:
                self._json(404, {"ok": False, "error": str(e)})
                return
            except ValueError as e:
                self._json(400, {"ok": False, "error": str(e)})
                return
            except Exception as e:
                self._json(500, {"ok": False, "error": str(e)})
                return
            self._json(200, info)
            return

        if path == "/index/rebuild":
            with _lock:
                if _index_status["running"]:
                    self._json(409, {"error": "index already running"})
                    return
            if not _CRAWL_JSON.is_file():
                self._json(400, {"error": "no crawl cache; upload first"})
                return
            t = threading.Thread(target=run_index_job, daemon=True)
            t.start()
            self._json(
                200,
                {
                    "ok": True,
                    "started": True,
                    "crawl": str(_CRAWL_JSON),
                    "out": str(_OUT),
                },
            )
            return

        if path == "/pan/rpc":
            # body: {op, params?, wait?: true}
            op = data.get("op")
            if not op:
                self._json(
                    400,
                    {"error": "op required (list|exists|search|upload|…)"},
                )
                return
            params = data.get("params") or {}
            # 允许顶层扁平参数
            for k in (
                "dir",
                "path",
                "key",
                "recursive",
                "max_entries",
                "num",
                "auto_index",
                "autoIndex",
                "concurrency",
                "local",
                "dest",
                "newname",
                "ondup",
                "file_token",
                "token",
            ):
                if k in data and k not in params:
                    params[k] = data[k]
            # upload：本机路径 → 注册 token，扩展再拉文件并 precreate/upload/create
            if str(op) in ("upload", "upload_file"):
                local = params.get("local") or params.get("path_local") or ""
                if local and not params.get("file_token") and not params.get("token"):
                    try:
                        reg = register_local_file(str(local))
                    except Exception as e:
                        self._json(400, {"ok": False, "error": f"register local failed: {e}"})
                        return
                    params["file_token"] = reg["token"]
                    params["local_meta"] = {
                        "name": reg["name"],
                        "size": reg["size"],
                        "content_md5": reg["content_md5"],
                        "slice_md5": reg["slice_md5"],
                        "block_list": reg["block_list"],
                        "block_size": reg["block_size"],
                        "url": reg["url"],
                    }
                    if not params.get("newname"):
                        params["newname"] = reg["name"]
            rid = enqueue_rpc(str(op), params)
            default_timeout = 600.0 if str(op) in ("upload", "upload_file") else 90.0
            if data.get("wait", True):
                self._json(
                    200,
                    wait_rpc(
                        rid,
                        timeout_sec=float(data.get("timeout", default_timeout)),
                    ),
                )
            else:
                self._json(200, {"ok": True, "id": rid, "status": "pending"})
            return

        if path == "/pan/rpc/result":
            rid = data.get("id")
            if not rid:
                self._json(400, {"error": "id required"})
                return
            with _lock:
                r = _rpc.get(rid)
                if not r:
                    self._json(404, {"error": "rpc not found"})
                    return
                if data.get("ok", True):
                    r["status"] = "done"
                    r["result"] = data.get("result")
                    r["error"] = None
                else:
                    r["status"] = "error"
                    r["error"] = data.get("error") or "unknown"
                    r["result"] = data.get("result")
            self._json(200, {"ok": True, "id": rid})
            return

        if path == "/push":
            pack = data.get("pack", data)
            if "path" in data and "tasks" not in (pack or {}):
                pack = load_pack(Path(data["path"]))
            if not isinstance(pack, dict) or "id" not in pack or "tasks" not in pack:
                self._json(400, {"error": "pack needs id and tasks"})
                return
            auto = bool(data.get("auto", pack.get("auto") or pack.get("auto_execute")))
            mode = str(
                data.get("mode")
                or data.get("auto_mode")
                or (pack.get("auto_policy") or {}).get("mode")
                or "all"
            )
            stored = push_pack(pack, auto=auto, mode=mode)
            self._json(
                200,
                {
                    "ok": True,
                    "id": stored["id"],
                    "tasks": len(stored.get("tasks") or []),
                    "auto": bool(stored.get("auto")),
                    "auto_policy": stored.get("auto_policy"),
                    "push_seq": stored.get("push_seq"),
                    "run_status": "queued",
                },
            )
            return

        if path == "/run/result":
            # 扩展 connector 回写执行进度
            rid = data.get("id") or data.get("pack_id")
            if not rid:
                self._json(400, {"error": "id required"})
                return
            with _lock:
                prev = _runs.get(rid) or {
                    "id": rid,
                    "created": time.time(),
                }
                prev.update(
                    {
                        "status": data.get("status") or prev.get("status") or "running",
                        "counts": data.get("counts") or prev.get("counts") or {},
                        "tasks": data.get("tasks") if data.get("tasks") is not None else prev.get("tasks"),
                        "error": data.get("error"),
                        "log_tail": data.get("log_tail") or prev.get("log_tail") or [],
                        "push_seq": data.get("push_seq") or prev.get("push_seq"),
                        "updated": time.time(),
                    }
                )
                _runs[rid] = prev
                # 同步 history 中任务 status，便于 CLI 对照
                hist = _history.get(rid)
                if hist and isinstance(data.get("tasks"), list):
                    by_id = {t.get("id"): t for t in data["tasks"] if t.get("id")}
                    new_tasks = []
                    for t in hist.get("tasks") or []:
                        tt = dict(t)
                        if tt.get("id") in by_id:
                            src = by_id[tt["id"]]
                            if src.get("status"):
                                tt["status"] = src["status"]
                            if "result" in src:
                                tt["result"] = src["result"]
                            if src.get("error") and not tt.get("result"):
                                tt["result"] = {"error": src["error"]}
                        new_tasks.append(tt)
                    hist = dict(hist)
                    hist["tasks"] = new_tasks
                    _history[rid] = hist
                _save_state_unlocked()
            self._json(200, {"ok": True, "id": rid, "status": prev.get("status")})
            return

        if path == "/ack":
            ids = data.get("ids") or []
            with _lock:
                for i in ids:
                    _pending.pop(i, None)
                    if i in _runs and _runs[i].get("status") == "queued":
                        _runs[i]["status"] = "imported"
                        _runs[i]["updated"] = time.time()
                _save_state_unlocked()
            self._json(200, {"ok": True, "acked": ids})
            return

        if path == "/drop":
            ids = data.get("ids") or []
            drop_all = bool(data.get("all"))
            dropped = []
            with _lock:
                if drop_all and not ids:
                    dropped = list(_history.keys())
                    _pending.clear()
                    _history.clear()
                else:
                    for i in ids:
                        if i in _pending:
                            _pending.pop(i, None)
                        if i in _history:
                            _history.pop(i, None)
                            dropped.append(i)
                _save_state_unlocked()
            self._json(200, {"ok": True, "dropped": dropped})
            return

        self._json(404, {"error": "not found"})


def main() -> None:
    ap = argparse.ArgumentParser(description="Baidu pan task bridge + index rebuild")
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument(
        "--push",
        action="append",
        default=[],
        help="启动时推送的任务包 JSON 路径，可重复",
    )
    ap.add_argument(
        "--vault",
        default=None,
        help="覆盖 vault 根路径（默认从 bridge.py 位置推断）",
    )
    args = ap.parse_args()

    global _VAULT, _INDEX_PY, _OUT
    if args.vault:
        _VAULT = Path(args.vault).resolve()
        _INDEX_PY = _VAULT / "scripts" / "baidu-pan-index.py"
        _OUT = _VAULT / "5-External" / "baidu-pan"

    _load_state()

    for p in args.push:
        pack = load_pack(Path(p))
        stored = push_pack(pack, auto=False)
        print(f"[bridge] queued {stored['id']} ({len(stored['tasks'])} tasks) from {p}")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    # 允许大 body
    httpd.request_queue_size = 16
    print(f"[bridge] listening on http://{args.host}:{args.port}")
    print(f"[bridge] skill_root={_SKILL_ROOT}")
    print(f"[bridge] runtime_root={_RUNTIME_ROOT}")
    print(f"[bridge] vault={_VAULT}")
    print(f"[bridge] index={_INDEX_PY}")
    print(f"[bridge] out={_OUT}")
    print(f"[bridge] state={_STATE_DIR}")
    print(
        "[bridge] pan/list  pan/exists  pan/rpc  pan/rpc/pending  pan/rpc/result  "
        "crawl/upload  index/rebuild  pending  push  run/status  run/result"
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] stop")


if __name__ == "__main__":
    main()
