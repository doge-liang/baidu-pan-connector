#!/usr/bin/env python3
"""百度网盘任务 CLI（主控）。扩展仅作 connector 执行盘上 API。

依赖：bridge 已启动 + pan.baidu.com 已登录页签 + 扩展 0.3.0+。

示例:
  python -B tools/pan_task.py push <runtime>/tasks/xxx.json --auto --wait
  python -B tools/pan_task.py push xxx.json --auto --mode safe --wait
  python -B tools/pan_task.py status <pack-id>
  python -B tools/pan_task.py wait <pack-id>
  python -B tools/pan_task.py health
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BRIDGE = "http://127.0.0.1:27865"


def get(url: str, timeout: float = 30) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def post(url: str, body: dict, timeout: float = 60) -> dict:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def load_pack(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if "id" not in data or "tasks" not in data:
        raise SystemExit("任务包须含 id 与 tasks")
    return data


def cmd_health(_: argparse.Namespace) -> int:
    try:
        h = get(f"{BRIDGE}/health")
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(h, ensure_ascii=False, indent=2))
    return 0 if h.get("ok") else 1


def wait_run(pack_id: str, timeout: float = 600, interval: float = 2.0) -> int:
    deadline = time.time() + timeout
    last_line = ""
    terminal = {"done", "failed", "partial", "needs_human", "error"}
    while time.time() < deadline:
        try:
            st = get(f"{BRIDGE}/run/status?id={urllib.parse.quote(pack_id)}")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                print(f"[wait] run not found yet id={pack_id}")
                time.sleep(interval)
                continue
            print(f"[wait] HTTP {e.code}: {e}", file=sys.stderr)
            time.sleep(interval)
            continue
        except Exception as e:
            print(f"[wait] {e}", file=sys.stderr)
            time.sleep(interval)
            continue
        run = st.get("run") or {}
        status = run.get("status") or "?"
        counts = run.get("counts") or {}
        err = run.get("error")
        line = f"status={status} counts={counts}" + (f" err={err}" if err else "")
        if line != last_line:
            print(f"[wait] {line}")
            last_line = line
            for t in run.get("tasks") or []:
                if t.get("status") == "failed":
                    print(f"  FAIL {t.get('id')}: {t.get('error') or t.get('result')}")
            if status in terminal:
                for ln in (run.get("log_tail") or [])[-15:]:
                    print(ln)
        if status in terminal:
            print(json.dumps(run, ensure_ascii=False, indent=2))
            if status == "done" and not (counts.get("failed") or 0):
                return 0
            if status == "needs_human":
                return 3
            if status == "partial" and not (counts.get("failed") or 0):
                return 0
            return 1
        time.sleep(interval)
    print(f"[wait] timeout after {timeout}s", file=sys.stderr)
    return 4


def cmd_push(args: argparse.Namespace) -> int:
    path = Path(args.pack)
    if not path.is_file():
        print(f"文件不存在: {path}", file=sys.stderr)
        return 2
    pack = load_pack(path)
    body = {
        "pack": pack,
        "auto": bool(args.auto),
        "mode": args.mode or "all",
    }
    try:
        out = post(f"{BRIDGE}/push", body)
    except urllib.error.URLError as e:
        print(
            f"无法连接 bridge ({BRIDGE})：{e}\n"
            "请先运行 Skill 中的 scripts/start_connector.ps1",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if not out.get("ok"):
        return 1
    pack_id = out.get("id") or pack["id"]
    if args.wait:
        return wait_run(pack_id, timeout=args.timeout, interval=args.interval)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    try:
        if args.pack_id:
            st = get(f"{BRIDGE}/run/status?id={urllib.parse.quote(args.pack_id)}")
        else:
            st = get(f"{BRIDGE}/run/status")
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(st, ensure_ascii=False, indent=2))
    return 0


def cmd_wait(args: argparse.Namespace) -> int:
    return wait_run(args.pack_id, timeout=args.timeout, interval=args.interval)


def cmd_drop(args: argparse.Namespace) -> int:
    body: dict = {}
    if args.all:
        body["all"] = True
    else:
        body["ids"] = [args.pack_id] if args.pack_id else []
    try:
        out = post(f"{BRIDGE}/drop", body)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get("ok") else 1


def main() -> None:
    global BRIDGE
    ap = argparse.ArgumentParser(description="Baidu pan task CLI (auto connector)")
    ap.add_argument("--bridge", default=BRIDGE)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_h = sub.add_parser("health", help="bridge 健康检查")
    p_h.set_defaults(func=cmd_health)

    p_push = sub.add_parser("push", help="推送任务包；--auto 预核准并由扩展执行")
    p_push.add_argument("pack", help="任务包 JSON 路径")
    p_push.add_argument("--auto", action="store_true", help="自动核准并执行")
    p_push.add_argument(
        "--mode",
        choices=["all", "safe"],
        default="all",
        help="all=含删除；safe=跳过 delete/high",
    )
    p_push.add_argument("--wait", action="store_true", help="等待执行结束")
    p_push.add_argument("--timeout", type=float, default=3600)
    p_push.add_argument("--interval", type=float, default=2.0)
    p_push.set_defaults(func=cmd_push)

    p_st = sub.add_parser("status", help="查看 run 状态")
    p_st.add_argument("pack_id", nargs="?", default="")
    p_st.set_defaults(func=cmd_status)

    p_w = sub.add_parser("wait", help="等待某 pack 执行结束")
    p_w.add_argument("pack_id")
    p_w.add_argument("--timeout", type=float, default=3600)
    p_w.add_argument("--interval", type=float, default=2.0)
    p_w.set_defaults(func=cmd_wait)

    p_d = sub.add_parser("drop", help="从 bridge 丢弃任务包")
    p_d.add_argument("pack_id", nargs="?", default="")
    p_d.add_argument("--all", action="store_true")
    p_d.set_defaults(func=cmd_drop)

    args = ap.parse_args()
    BRIDGE = args.bridge.rstrip("/")
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
