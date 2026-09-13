# baidu-pan-connector

Baidu Netdisk Agent Connector combines a Codex skill, a local loopback bridge,
and an unpacked Chrome extension. It can list, search, create, move, rename,
copy, delete, upload, and download files through an already logged-in `pan.baidu.com`
session.

This is unofficial software and is not affiliated with Baidu. It does not
persist browser cookies or `bdstoken` values.

## Source of truth

The complete product lives under:

```text
skills/baidu-pan-connector/
  SKILL.md
  agents/openai.yaml
  extension/
  tools/
  scripts/
  references/
  tasks/                 examples only
```

Do not maintain a second extension or skill source tree. On a development
machine, point the Codex skill installation at this directory and load Chrome
directly from `skills/baidu-pan-connector/extension`.

## Windows development installation

Clone the repository to a stable path, for example:

```powershell
git clone https://github.com/doge-liang/baidu-pan-connector.git D:\project\baidu-pan-connector
```

Use a directory link for the Codex installation or deploy with the controlled
sync script. The link keeps the installed Skill and repository source identical.

```powershell
$source = 'D:\project\baidu-pan-connector\skills\baidu-pan-connector'
$install = Join-Path $env:USERPROFILE '.codex\skills\baidu-pan-connector'
New-Item -ItemType Junction -Path $install -Target $source
```

Load this unpacked extension in Chrome:

```text
D:\project\baidu-pan-connector\skills\baidu-pan-connector\extension
```

Runtime data is external to Git:

```text
%USERPROFILE%\.codex\state\baidu-pan-connector\
  tasks\
  logs\
  cache\
  index-out\
  packs.json
```

Set `BAIDU_PAN_CONNECTOR_STATE_DIR` to an absolute path to override the default.

## Start and verify

```powershell
$S = Join-Path $env:USERPROFILE '.codex\skills\baidu-pan-connector'
powershell -File "$S\scripts\start_connector.ps1" -Background
python -B "$S\scripts\check_install.py"
python -B "$S\scripts\sync_install.py" --check --require-source-link
```

The strict check confirms that the Codex Skill entry is a directory link to
this checkout, rather than a drifting duplicate. For a deliberately copied
installation, omit `--require-source-link`; byte-for-byte consistency is still
verified.

Everyday commands:

```powershell
$TOOLS = Join-Path $S 'tools'
$TASKS = Join-Path $env:USERPROFILE '.codex\state\baidu-pan-connector\tasks'
python -B "$TOOLS\pan_task.py" health
python -B "$TOOLS\pan_query.py" list '/' --max 20
python -B "$TOOLS\pan_query.py" search '关键词' --dir '/'
python -B "$TOOLS\pan_query.py" upload 'D:\local\file.pdf' --dest '/remote/dir'
python -B "$TOOLS\pan_query.py" download '/remote/dir/file.pdf' --dest 'D:\downloads'
python -B "$TOOLS\pan_task.py" push "$TASKS\my.json" --auto --wait
```

## Safety and publication

- Keep real task packs, bridge state, logs, caches, and generated indexes out of Git.
- Do not run Python inside `extension/`; Chrome rejects generated underscore-prefixed paths such as `__pycache__`.
- Keep the browser extension status-only. User confirmation and task control belong in the Agent and CLI workflow.
- The bridge atomically claims live RPC requests so multiple open Pan tabs and the MV3 service worker cannot execute the same transfer or mutation concurrently.
- Downloads stream through the logged-in browser to a same-directory partial file; the bridge verifies size and available MD5 metadata before atomically installing the target.
- Build the Chrome Web Store package with `extension/store/pack.py`; the package contains only extension runtime files and icons.

## License

Apache-2.0. See `LICENSE` and `skills/baidu-pan-connector/SOURCES.md`.
