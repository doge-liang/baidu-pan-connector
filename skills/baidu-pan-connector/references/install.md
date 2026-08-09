# Installation and runtime layout

Use one source checkout and keep runtime data outside it.

## Windows layout

```text
D:\project\baidu-pan-connector\
  skills\baidu-pan-connector\       source of truth

%USERPROFILE%\.codex\skills\baidu-pan-connector
  directory link to the source skill

%USERPROFILE%\.codex\state\baidu-pan-connector\
  tasks\                            private task packs
  logs\                             bridge logs
  cache\                            crawl and Python caches
  index-out\                        generated index data
  packs.json                        bridge state
```

Override the runtime root with the absolute path environment variable
`BAIDU_PAN_CONNECTOR_STATE_DIR` when required.

## Start and verify

```powershell
$S = Join-Path $env:USERPROFILE ".codex\skills\baidu-pan-connector"
powershell -File "$S\scripts\start_connector.ps1" -Background
python -B "$S\scripts\check_install.py"
```

Load the unpacked Chrome extension from the canonical checkout:

```text
D:\project\baidu-pan-connector\skills\baidu-pan-connector\extension
```

Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, then
open a logged-in `https://pan.baidu.com` tab. Reload the extension after updates.

## Verify installation consistency

```powershell
python -B "$S\scripts\sync_install.py" --check
```

The check must pass before publishing or troubleshooting runtime behavior. The
source directory contains only task examples; write real task packs under the
external runtime `tasks` directory.
