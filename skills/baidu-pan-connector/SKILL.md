---
name: baidu-pan-connector
description: >-
  Operate Baidu Netdisk (百度网盘) via the bundled Baidu Pan Agent Connector:
  Chrome extension + local bridge CLI — list/exists/search, mkdir/move/rename/copy/delete,
  upload/download,
  batch task packs, optional crawl. Includes install check.
  TRIGGER: 百度网盘, 网盘, pan.baidu, baidu-pan, bridge, 任务包, connector, 扩展操作网盘,
  安装检查, check_install; pan file ops through extension+bridge.
  Context continuity: if this conversation is already doing pan ops, follow-ups need not
  re-mention 网盘.
  Prefer this over baidu-drive for full-tree pan.baidu.com via connector (not bdpan sandbox).
  DO NOT TRIGGER: bdpan-only /apps/bdpan memory-backup (use baidu-drive);
  share-link transfer or OpenAPI-only flows (use baidu-drive or web UI); non-pan tasks;
  文库 PPT (baidu-wenku-aippt).
  Supports local→pan upload and pan→local verified streaming download via the bridge.
  Share-link transfer/share creation still use baidu-drive or web UI.
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
2. Intent is concrete enough (list / search / move / mkdir / delete / **upload / download** / push pack / crawl / install check).

Do **not** run connector commands for unrelated tasks.
Share-link transfer / share creation: use **baidu-drive** or the web UI (not this connector).

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
| **Medium (confirm if ambiguous)** | move, rename, copy, upload/download when path unclear; download overwrite | Confirm target; if paths verified, run |
| **Low (run)** | list, exists, search, mkdir, health, check_install | No confirm |

Extra rules (from baidu-drive):

- Vague intent (“处理一下文件”) → ask upload vs download vs organize vs delete.
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
| **Download remote file** | `pan_query.py download <remote> --dest <local-dir>` or pack `op: download` |
| Crawl | `pan_query.py crawl-start` (heavy) |
| Share-link transfer / share | Not in connector → baidu-drive or web UI |

Pack `op`: `mkdir` | `copy` | `copy-batch` | `move` | `rename` | `delete` | **`upload`** | **`download`** | `normalize-dir`.

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

### Download (pan → local)

Requires: bridge running, extension **reloaded to 0.7.14+**, pan.baidu.com logged in.

```powershell
# one-shot: remote file → local directory (keeps remote basename)
python -B "$TOOLS\pan_query.py" download "/remote/dir/file.pdf" --dest "D:\downloads"

# explicit local filename; overwrite must be explicit
python -B "$TOOLS\pan_query.py" download "/remote/dir/file.pdf" --local "D:\downloads\renamed.pdf" --ondup overwrite

# task pack
# { "op":"download", "path":"/remote/dir/file.pdf", "dest":"D:\\downloads", "ondup":"fail" }
python -B "$TOOLS\pan_task.py" push "$TASKS\my-download.json" --auto --wait --timeout 3600
```

| `ondup` | Behavior |
|---|---|
| `fail` | Stop if the local target exists (default) |
| `overwrite` | Replace only after the complete temporary file passes verification |

Mechanism: the background service worker uses `chrome.scripting.executeScript` with `world: MAIN` only in the requesting Pan tab. Version 0.7.14 follows the current Netdisk web bundle by calling same-origin `/api/gettemplatevariable` for fresh `sign1/sign2/sign3/timestamp`. Unlike the first-party page, the extension does not evaluate the remotely supplied `sign2` source; it applies the bundled, auditable equivalent transformation to the fresh `sign1/sign3` inputs and returns only the computed base64 signature, timestamp, VIP class, and a non-sensitive source label. Raw signature inputs and cookies are never logged or exported. Historical `yunData` and the isolated-world HTML parser remain compatibility fallbacks. The content script calls `/api/download` with GET and the current `fidlist/type/vip/sign/timestamp` parameters; metadata and legacy `/api/filemetas` dlinks remain lower-priority fallback sources. It then arms a short-lived capture for one exact validated dlink and navigates a hidden subframe in the logged-in Pan document. A permanently registered `downloads.onDeterminingFilename` listener asks Chrome to redirect only the matching attachment to `baidu-pan-connector/<token>.download`; unrelated downloads are ignored. Chrome resolves this relative path against the configured download root, and a server `Content-Disposition` header may replace the basename. The bridge therefore accepts either the exact random token name or, for an overridden name, only a file created after registration whose length and 32-character MD5 match the Baidu metadata. If the page-context route produces no attachment, the extension retries evidence-backed browser, legacy `netdisk`, OpenAPI `pan.baidu.com`, and PCS client header profiles through Chrome's download manager and credentialed streaming fetch. Streaming writes sequential chunks of at most 4 MiB to the bridge's offset-checked endpoint; temporary session rules are removed after the attempt. Safe failure diagnostics retain only numeric API error codes and short error messages. All successful routes end in the same same-directory partial target; the bridge verifies the expected size and available 32-character MD5 before installing it with `os.replace`, then removes the native staging file while the extension removes the download-history entry and makes a second file-cleanup attempt. Any failed transfer removes its partial file through the abort path. Directory recursion and resume are not supported in 1.7.14; submit explicit file tasks.

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
| Local download | Yes (`download` op / CLI) | Yes |
| Share-link transfer / share | No | Yes |
| Disk reorganize (mkdir/move/…) | Yes (task packs) | Yes |

Install baidu-drive (if needed for share-link transfer/share):

```bash
npx skills add https://github.com/baidu-netdisk/bdpan-storage/skills --skill baidu-drive
```

---

## Extension reload after upgrade

After updating this skill’s `extension/`, open `chrome://extensions` → **Reload** on *Baidu Pan Agent Connector* (need **0.7.14+** for the current `/api/gettemplatevariable` dynamic signature protocol, GET `/api/download`, page-context attachment capture, verified native download, and sequential bridge-stream fallback). On the development machine, Chrome must load the canonical checkout directly:

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
