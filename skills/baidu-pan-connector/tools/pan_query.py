#!/usr/bin/env python3
"""经 bridge 查询/上传百度网盘（需：bridge 运行 + pan.baidu.com 已开 + 扩展已加载）。

示例:
  python pan_query.py list "/"
  python pan_query.py exists "/path"
  python pan_query.py search "关键词" --dir "/"
  python pan_query.py upload "D:\\local\\file.pdf" --dest "/apps/demo"
  python pan_query.py upload "D:\\local\\file.pdf" --path "/apps/demo/file.pdf"
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

BRIDGE = "http://127.0.0.1:27865"


def get(url: str, timeout: float = 120) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def post(url: str, body: dict, timeout: float = 120) -> dict:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser(description="Baidu pan live query/upload via extension bridge")
    ap.add_argument(
        "op",
        choices=[
            "list",
            "exists",
            "search",
            "upload",
            "rpc",
            "crawl-start",
            "crawl-status",
            "crawl-stop",
            "crawl-upload-rebuild",
            "index-status",
            "pack-status",
            "panel-log",
        ],
    )
    ap.add_argument("arg", nargs="?", default="", help="dir / path / key / local file / rpc json")
    ap.add_argument("--dir", default="/", help="search root")
    ap.add_argument("--dest", default="", help="upload: remote directory")
    ap.add_argument("--path", default="", help="upload: full remote path")
    ap.add_argument("--newname", default="", help="upload: remote filename")
    ap.add_argument(
        "--ondup",
        default="fail",
        choices=["fail", "overwrite", "newcopy"],
        help="upload: if remote exists",
    )
    ap.add_argument("--recursive", action="store_true")
    ap.add_argument("--max", type=int, default=500)
    ap.add_argument(
        "--auto-index",
        action="store_true",
        help="crawl-start: 完成后自动上传并重建索引",
    )
    ap.add_argument("--timeout", type=float, default=0, help="rpc wait seconds (upload default 600)")
    ap.add_argument("--bridge", default=BRIDGE)
    args = ap.parse_args()

    if args.op == "list":
        q = urllib.parse.urlencode(
            {
                "dir": args.arg or "/",
                "wait": "1",
                "recursive": "1" if args.recursive else "0",
                "max": str(args.max),
            }
        )
        out = get(f"{args.bridge}/pan/list?{q}")
    elif args.op == "exists":
        q = urllib.parse.urlencode({"path": args.arg})
        out = get(f"{args.bridge}/pan/exists?{q}")
    elif args.op == "search":
        out = post(
            f"{args.bridge}/pan/rpc",
            {"op": "search", "key": args.arg, "dir": args.dir, "num": args.max, "wait": True},
        )
    elif args.op == "upload":
        local = args.arg
        if not local:
            print("usage: pan_query.py upload <local-file> --dest /remote/dir [--newname n]", file=sys.stderr)
            sys.exit(2)
        lp = Path(local).expanduser()
        if not lp.is_file():
            print(f"local file not found: {lp}", file=sys.stderr)
            sys.exit(2)
        body = {
            "op": "upload",
            "local": str(lp.resolve()),
            "wait": True,
            "timeout": args.timeout or 600,
            "ondup": args.ondup,
        }
        if args.path:
            body["path"] = args.path
        if args.dest:
            body["dest"] = args.dest
        if args.newname:
            body["newname"] = args.newname
        if not args.path and not args.dest:
            print("upload requires --dest DIR or --path /full/remote/path", file=sys.stderr)
            sys.exit(2)
        out = post(f"{args.bridge}/pan/rpc", body, timeout=max(args.timeout or 600, 120))
    elif args.op == "crawl-start":
        out = post(
            f"{args.bridge}/pan/rpc",
            {
                "op": "crawl_start",
                "params": {"auto_index": bool(args.auto_index)},
                "auto_index": bool(args.auto_index),
                "wait": True,
            },
            timeout=60,
        )
    elif args.op == "crawl-status":
        out = post(
            f"{args.bridge}/pan/rpc",
            {"op": "crawl_status", "wait": True},
            timeout=30,
        )
    elif args.op == "crawl-stop":
        out = post(
            f"{args.bridge}/pan/rpc",
            {"op": "crawl_stop", "wait": True},
            timeout=30,
        )
    elif args.op == "crawl-upload-rebuild":
        out = post(
            f"{args.bridge}/pan/rpc",
            {"op": "crawl_upload_rebuild", "wait": True},
            timeout=60,
        )
    elif args.op == "index-status":
        out = get(f"{args.bridge}/index/status", timeout=15)
    elif args.op == "pack-status":
        out = post(
            f"{args.bridge}/pan/rpc",
            {
                "op": "pack_status",
                "params": {"id": args.arg} if args.arg else {},
                "wait": True,
            },
            timeout=30,
        )
    elif args.op == "panel-log":
        out = post(
            f"{args.bridge}/pan/rpc",
            {"op": "panel_log", "params": {"n": args.max or 80}, "wait": True},
            timeout=30,
        )
    else:
        out = post(f"{args.bridge}/pan/rpc", json.loads(args.arg or "{}"))

    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    if not out.get("ok") and out.get("status") != "done":
        if args.op not in ("index-status",) or out.get("error"):
            if args.op == "index-status":
                return
            sys.exit(1)
    # upload result nested
    if args.op == "upload":
        res = out.get("result") if isinstance(out.get("result"), dict) else out
        if res and res.get("ok") is False:
            sys.exit(1)


if __name__ == "__main__":
    main()
