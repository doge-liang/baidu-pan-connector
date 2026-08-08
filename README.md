# baidu-pan-connector

**Baidu Netdisk Agent Connector** — Chrome extension + local bridge CLI so coding agents (Codex, Claude Code, etc.) can **list / search / mkdir / move / rename / copy / delete / upload** on a logged-in [pan.baidu.com](https://pan.baidu.com) session.

Unofficial. Not affiliated with Baidu. Does **not** store cookies or `bdstoken`.

## Install skill (Codex / skills CLI)

```bash
# Codex / agents that support `skills add`
npx skills add https://github.com/doge-liang/baidu-pan-connector/skills --skill baidu-pan-connector
```

Or copy `skills/baidu-pan-connector` into `~/.codex/skills/baidu-pan-connector`.

## One-time setup

1. **Bridge** (keep running):

```powershell
python %USERPROFILE%\.codex\skills\baidu-pan-connector\tools\bridge.py
# or from this repo after install:
python skills/baidu-pan-connector/tools/bridge.py
```

2. **Chrome extension** — Load unpacked:

```text
…/baidu-pan-connector/extension
```

`chrome://extensions` → Developer mode → Load unpacked → select `extension/`.

3. Open https://pan.baidu.com and stay logged in (keep the tab open).

4. **Install check**:

```powershell
python …/baidu-pan-connector/scripts/check_install.py
```

Expect `RESULT: PASS` and ideally `pan RPC responded`.

## Everyday commands

```powershell
$S = "$env:USERPROFILE\.codex\skills\baidu-pan-connector"
python "$S\tools\pan_task.py" health
python "$S\tools\pan_query.py" list "/" --max 20
python "$S\tools\pan_query.py" search "关键词" --dir "/"
python "$S\tools\pan_query.py" upload "D:\local\file.pdf" --dest "/remote/dir"
python "$S\tools\pan_task.py" push "$S\tasks\my.json" --auto --wait
```

### Task pack example

```json
{
  "schema": "baidu-pan-task-pack/v1",
  "id": "demo-move",
  "title": "move demo",
  "tasks": [
    {
      "id": "t1",
      "op": "move",
      "path": "/a/file.pdf",
      "dest": "/b",
      "newname": "file.pdf",
      "risk": "low"
    }
  ]
}
```

Supported `op`: `mkdir` | `move` | `rename` | `copy` | `copy-batch` | `delete` | `upload` | `normalize-dir`.

### Upload

```powershell
python "$S\tools\pan_query.py" upload "D:\path\file.pdf" --dest "/inbox"
python "$S\tools\pan_query.py" upload "D:\path\file.pdf" --path "/inbox/file.pdf" --ondup overwrite
```

Bridge registers the local file (MD5 + 4 MiB blocks); the extension uploads with the web session (`precreate` → PCS parts → `create`).

## Layout

```text
skills/baidu-pan-connector/
  SKILL.md                 # agent instructions
  INSTALL.md
  VERSION
  extension/               # Chrome MV3 (Load unpacked here only)
  tools/                   # bridge.py, pan_task.py, pan_query.py
  scripts/check_install.py
  tasks/                   # your packs (examples only in repo)
  references/
```

Do **not** run Python inside `extension/` (Chrome rejects `__pycache__`).

## vs baidu-drive

| | baidu-pan-connector | [baidu-drive](https://github.com/baidu-netdisk/bdpan-storage) |
|---|---|---|
| Transport | Extension + bridge | `bdpan` OpenAPI CLI |
| Scope | Full tree of the logged-in account | Often `/apps/bdpan/` |
| Upload | Yes | Yes |
| Download / transfer / share | No | Yes |

Agent behavior patterns (confirm matrix, safety notes) are adapted from baidu-drive; see `SOURCES.md` inside the skill.

## License

Apache-2.0. Unofficial third-party connector.
