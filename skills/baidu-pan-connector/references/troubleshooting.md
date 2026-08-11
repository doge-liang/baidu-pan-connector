# Troubleshooting

## Install check first

```powershell
python -B "$env:USERPROFILE\.codex\skills\baidu-pan-connector\scripts\check_install.py"
```

Human steps: [install.md](./install.md).

## Bridge unreachable

```
Cannot connect to bridge (http://127.0.0.1:27865)
```

1. Start the **skill-bundled** bridge and leave it running:

```powershell
powershell -File "$env:USERPROFILE\.codex\skills\baidu-pan-connector\scripts\start_connector.ps1"
```

2. Confirm nothing else is bound to **27865** (older notes may mention 17865; current default is 27865).
3. Bridge is loopback-only by design.
4. State dir: `%USERPROFILE%\.codex\state\baidu-pan-connector` (not inside the source or extension tree).

## waiting_tab / RPC no reply

- No open https://pan.baidu.com session tab
- Tab slept or crashed → refresh / reopen
- Extension not loaded (Developer mode → Load unpacked)
- Extension too old for `--auto` (need 0.3.0+; prefer 0.4.0+)

## Extension fails to load

- Load unpacked path must be the **`extension`** folder, not the skill root:

```text
%USERPROFILE%\.codex\skills\baidu-pan-connector\extension
```

- Do not run Python inside `extension/` (avoids `__pycache__`)
- Do not place `_`-prefixed paths in the extension root (Chrome rejects them)
- CLI lives in sibling `tools/`; private task JSON lives in the external runtime `tasks/` directory

## `Extension context invalidated` after Reload

Chrome invalidates every content-script context created by the previous extension instance
when the extension is reloaded. The Connector stops its bridge and RPC polling, changes the
panel to the red state, and asks for a page refresh instead of continuing to throw errors.

Refresh the existing `https://pan.baidu.com/` tab once after every extension reload. This
creates a new content-script context from the reloaded extension; reloading the extension
alone cannot replace a script that is already running in an open page.

## Push accepted but nothing runs

1. `pan_task.py health`
2. `pan_query.py panel-log`
3. `pan_task.py status <id>` for `waiting_tab` / `failed` / `needs_human`
4. Packs without `--auto` need panel approval
5. `--mode safe` holds delete/high

## list/search empty or timeout

- Smaller dir, lower `--max`
- RPC TTL is finite (~minutes); restart bridge and retry
- Rate limits: wait and retry

## partial / task FAIL

- Read `FAIL <task-id>` and error in status output
- Common: missing source, missing dest parent, name conflict
- `exists` / `list` parent → `mkdir` if needed → retry with a **new pack id** (or same id with new `push_seq` via re-push)

## crawl / index

```powershell
python "$TOOLS\pan_query.py" crawl-status
python "$TOOLS\pan_query.py" index-status
```

Full-disk crawl is slow and heavy. Run only when the user explicitly wants it. `--auto-index` rebuilds whatever index pipeline the install configures after crawl.

## Confused with baidu-drive

| | baidu-pan-connector | baidu-drive |
|---|---|---|
| Stack | Extension + bridge | `bdpan` CLI |
| Tree | Full account tree | Often app-limited paths |
| Local upload | Supported through bridge registration and extension 0.5.0+ | Often supported by bdpan |
| Local download | Supported through verified bridge streaming and extension 0.7.0+ | Often supported by bdpan |

Pick the stack the user actually has running.
