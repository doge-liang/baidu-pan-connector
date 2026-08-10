---
name: baidu-pan-connector
description: >-
  Operate Baidu Netdisk (百度网盘) via the bundled Baidu Pan Agent Connector:
  Chrome extension + local bridge CLI — list/exists/search, mkdir/move/rename/copy/delete,
  batch task packs, optional crawl. Includes install check.
  TRIGGER: 百度网盘, 网盘, pan.baidu, baidu-pan, bridge, 任务包, connector, 扩展操作网盘,
  安装检查, check_install; pan file ops through extension+bridge.
  Context continuity: if this conversation is already doing pan ops, follow-ups need not
  re-mention 网盘.
  Prefer this over baidu-drive for full-tree pan.baidu.com via connector (not bdpan sandbox).
  DO NOT TRIGGER: bdpan-only /apps/bdpan memory-backup (use baidu-drive); local download,
  share-link transfer, or OpenAPI-only flows (use baidu-drive or web UI); non-pan tasks;
  文库 PPT (baidu-wenku-aippt).
  Supports local→pan upload via bridge file register + extension web API.
  Transfer/share still use baidu-drive or web UI.
---

# Baidu Pan Agent Connector

Self-contained Codex skill: **extension + CLI** live inside the skill directory.

The extension UI is status-only: red/green/blue connector state, current task summary,
and Debug log. Do not direct the user to approve, reject, import, clear, crawl, or execute
tasks in the browser panel; all control and confirmation stays in the Agent/CLI workflow.

Patterns for triggers, confirmation, and safety notes are adapted from the public
**baidu-drive** skill ([baidu-netdisk/bdpan-storage](https://github.com/baidu-netdisk/bdpan-storage));
the transport here is **extension + bridge**, not `bdpan`. See [SOURCES.md](./SOURCES.md).

| Path | Role |
|---|---|
| `extension/` | Chrome **Load unpacked** target |
| `tools/bridge.py` | `127.0.0.1:27865` |
| `tools/pan_task.py` | push / wait / status / health |
| `tools/pan_query.py` | list / exists / search / crawl |
| `tasks/` | Non-sensitive task-pack examples only |
| `scripts/check_install.py` | Install / readiness check |
| `scripts/start_connector.ps1` | Start the bridge with external runtime state |
| `scripts/sync_install.py` | Verify source-link or controlled-copy consistency |
| `references/install.md` | Human install guide |

```powershell
$S = Join-Path $env:USERPROFILE ".codex\skills\baidu-pan-connector"
$EXT = Join-Path $S "extension"
$TOOLS = Join-Path $S "tools"
$RUNTIME = Join-Path $env:USERPROFILE ".codex\state\baidu-pan-connector"
$TASKS = Join-Path $RUNTIME "tasks"
```

---

## Trigger rules

Execute pan ops only when:

1. User intent involves Baidu Netdisk / connector / bridge / task packs, **or** this chat is already mid pan-ops (continuity), and
2. Intent is concrete enough (list / search / move / mkdir / delete / **upload** / push pack / crawl / install check).

Do **not** run connector commands for unrelated tasks.
Transfer / share / download-to-local: use **baidu-drive** or the web UI (not this connector).

---

## Safety (highest priority)

1. Never read or print pan cookies, bdstoken, or OAuth tokens.
2. Never run Python inside `extension/` (Chrome rejects `__pycache__`).
3. Delete and large destructive batches: list impact → **user confirm** → then push.
4. Full-disk crawl / index rebuild: **only** on explicit user request.
5. User says 算了 / 不要了 / 取消 → stop; do not push further packs.
6. First session or first pan op in a while: briefly surface safety notes from [references/notes.md](./references/notes.md).

---

## Confirmation matrix

Adapted from baidu-drive’s risk tiers, mapped to connector ops:

| Level | Operations | Policy |
|---|---|---|
| **High (must confirm)** | `delete`; bulk move/rename (>20 items or unclear scope); crawl | List paths/counts; wait for explicit OK |
| **Medium (confirm if ambiguous)** | move, rename, copy, upload when path unclear | Confirm target; if paths verified, run |
| **Low (run)** | list, exists, search, mkdir, health, check_install | No confirm |

Extra rules (from baidu-drive):

- Vague intent (“处理一下文件”) → ask upload vs organize vs delete.
- Ordinals / pronouns (“第2个”, “它”) without a bound list → clarify.
- Cancel language → abort immediately.

---

## Preflight (every session / before writes)

Ordered checklist (same idea as baidu-drive’s 安装检查 → 登录检查):

1. **Package + bridge + tab**

```powershell
python -B "$S\scripts\sync_install.py" --check --require-source-link
python -B "$S\scripts\check_install.py"
```

| Result | Action |
|---|---|
| PASS | Continue |
| FAIL bridge | `powershell -File "$S\scripts\start_connector.ps1"` then re-check |
| FAIL / warn RPC | Load `$EXT` in Chrome; open logged-in https://pan.baidu.com |

2. **Path verify before mutate**
   `exists` / `list` source and parent of dest; `mkdir` missing parents if needed.

3. **Then** write pack → push → verify with list/search.

Install copy-paste for users: [references/install.md](./references/install.md).

### User-facing install blurb

```text
请完成 baidu-pan-connector 环境：
1) powershell -File %USERPROFILE%\.codex\skills\baidu-pan-connector\scripts\start_connector.ps1
2) Chrome 加载已解压扩展：%USERPROFILE%\.codex\skills\baidu-pan-connector\extension
3) 打开并登录 https://pan.baidu.com ，保持页签
4) python -B %USERPROFILE%\.codex\skills\baidu-pan-connector\scripts\check_install.py
至 PASS 后再操作。
```

---

## Capabilities

| Action | How |
|---|---|
| Health | `python -B "$TOOLS\pan_task.py" health` |
| List | `python -B "$TOOLS\pan_query.py" list "/path" --max 200` |
| Exists | `python -B "$TOOLS\pan_query.py" exists "/path"` |
| Search | `python -B "$TOOLS\pan_query.py" search "key" --dir "/" --max 50` |
| Writes | Task pack in `$TASKS\` → `pan_task.py push … --auto --wait` |
| **Upload local file** | `pan_query.py upload <local> --dest /remote/dir` or pack `op: upload` |
| Crawl | `pan_query.py crawl-start` (heavy) |
| Download / transfer / share | Not in connector → baidu-drive or web UI |

Pack `op`: `mkdir` | `copy` | `copy-batch` | `move` | `rename` | `delete` | **`upload`** | `normalize-dir`.

### Upload (local → pan)

Requires: bridge running, extension **reloaded to 0.5.0+**, pan.baidu.com logged in.

```powershell
# one-shot
python -B "$TOOLS\pan_query.py" upload "D:\path\file.pdf" --dest "/remote/dir"
python -B "$TOOLS\pan_query.py" upload "D:\path\file.pdf" --path "/remote/dir/file.pdf" --ondup overwrite

# task pack
# { "op":"upload", "local":"D:\\path\\file.pdf", "dest":"/remote/dir", "newname":"file.pdf", "ondup":"fail" }
python -B "$TOOLS\pan_task.py" push "$TASKS\my-upload.json" --auto --wait
```

| `ondup` | Behavior |
|---|---|
| `fail` | Skip if remote path exists (default) |
| `overwrite` | Replace (create rtype=3) |
| `newcopy` | Leave to pan naming |

Mechanism: bridge `POST /localfile/register` (MD5 + 4MiB blocks) → extension precreate / superfile2 / create.
Max size default 8 GiB (`BAIDU_PAN_UPLOAD_MAX_BYTES`).

### Verify-before-write (from baidu-drive style)

For move/rename/copy/delete:

1. Confirm source exists (`exists` or `list`).
2. Confirm dest parent exists (else `mkdir`).
3. Check name collision when possible.
4. Push pack; on partial, report FAIL task ids (see [references/error-table.md](./references/error-table.md)).

### Long-running ops (progress)

For large packs or crawl:

- Use `--wait` and surface `status` / `counts` from the CLI.
- Tell the user when work is in progress; on finish, report success/fail counts.
- Do not claim “all done” if status is `partial` or `failed`.

---

## Task packs

```powershell
python -B "$TOOLS\pan_task.py" push "$TASKS\my.json" --auto --wait
python -B "$TOOLS\pan_task.py" push "$TASKS\my.json" --auto --mode safe --wait
```

```json
{
  "schema": "baidu-pan-task-pack/v1",
  "id": "unique-id",
  "title": "title",
  "tasks": [
    { "id": "t1", "op": "mkdir", "path": "/a/b", "risk": "low" },
    {
      "id": "t2",
      "op": "move",
      "path": "/a/f.ext",
      "dest": "/b",
      "newname": "optional.ext",
      "risk": "low"
    },
    { "id": "t3", "op": "delete", "path": "/a/x.ext", "risk": "high" }
  ]
}
```

- Absolute pan paths starting with `/`.
- `dest` = directory; `newname` = filename only.
- Details: [references/task-pack.md](./references/task-pack.md).

---

## Result presentation

When reporting to the user (baidu-drive style clarity):

- Paths in full absolute form.
- Counts: succeeded / failed.
- Failures: task id + short error.
- Deletes: mention recycle bin recovery.
- Do not dump raw cookies or huge JSON unless asked.

---

## vs baidu-drive

| | This skill | [baidu-drive](https://github.com/baidu-netdisk/bdpan-storage) |
|---|---|---|
| Stack | Extension + bridge | `bdpan` CLI |
| Tree | Full account tree | Often `/apps/bdpan/` |
| Local upload | Yes (`upload` op / CLI) | Yes |
| Local download / transfer / share | No | Yes |
| Disk reorganize (mkdir/move/…) | Yes (task packs) | Yes |

Install baidu-drive (if needed for download/transfer/share):

```bash
npx skills add https://github.com/baidu-netdisk/bdpan-storage/skills --skill baidu-drive
```

---

## Extension reload after upgrade

After updating this skill’s `extension/`, open `chrome://extensions` → **Reload** on *Baidu Pan Agent Connector* (need **0.5.0+** for upload). On the development machine, Chrome must load the canonical checkout directly:

```text
D:\project\baidu-pan-connector\skills\baidu-pan-connector\extension
```

---

## Agent workflow

```
check_install.py
  → safety note if first use
  → pan_query resolve paths
  → confirm if high/ambiguous
  → write runtime tasks/*.json
  → push --auto --wait (report progress)
  → list/search verify
  → concise result to user
```

## References (load on demand)

| Doc | When |
|---|---|
| [references/install.md](./references/install.md) | Setup / Chrome load path and external state |
| [references/notes.md](./references/notes.md) | Safety notes |
| [references/examples.md](./references/examples.md) | Dialogue examples |
| [references/task-pack.md](./references/task-pack.md) | Pack schema |
| [references/cli-cheatsheet.md](./references/cli-cheatsheet.md) | CLI flags |
| [references/error-table.md](./references/error-table.md) | Failure messages |
| [references/troubleshooting.md](./references/troubleshooting.md) | Debugging |
| [SOURCES.md](./SOURCES.md) | Upstream attribution |
