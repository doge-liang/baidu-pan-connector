# CLI cheatsheet

Bundled under the skill (preferred):

```powershell
$S = "$env:USERPROFILE\.codex\skills\baidu-pan-connector"
$TOOLS = "$S\tools"
$RUNTIME = "$env:USERPROFILE\.codex\state\baidu-pan-connector"
$TASKS = "$RUNTIME\tasks"
```

Default bridge: `http://127.0.0.1:27865`.

## Install check

```powershell
python -B "$S\scripts\check_install.py"
```

## pan_task.py

```powershell
python -B "$TOOLS\pan_task.py" health
python -B "$TOOLS\pan_task.py" push "$TASKS\pack.json" --auto --wait
python -B "$TOOLS\pan_task.py" push "$TASKS\pack.json" --auto --mode safe --wait
python -B "$TOOLS\pan_task.py" status [pack-id]
python -B "$TOOLS\pan_task.py" wait <pack-id>
python -B "$TOOLS\pan_task.py" drop --all    # clears pending queue; use carefully
```

## pan_query.py

```powershell
python -B "$TOOLS\pan_query.py" list "/"
python -B "$TOOLS\pan_query.py" list "/path" --max 200
python -B "$TOOLS\pan_query.py" list "/path" --recursive --max 500
python -B "$TOOLS\pan_query.py" exists "/path"
python -B "$TOOLS\pan_query.py" search "keyword" --dir "/" --max 50
python -B "$TOOLS\pan_query.py" upload "D:\local\file.pdf" --dest "/remote/dir"
python -B "$TOOLS\pan_query.py" upload "D:\local\file.pdf" --path "/remote/dir/file.pdf" --ondup overwrite
python -B "$TOOLS\pan_query.py" crawl-start
python -B "$TOOLS\pan_query.py" crawl-start --auto-index
python -B "$TOOLS\pan_query.py" crawl-status
python -B "$TOOLS\pan_query.py" crawl-stop
python -B "$TOOLS\pan_query.py" crawl-upload-rebuild
python -B "$TOOLS\pan_query.py" index-status
python -B "$TOOLS\pan_query.py" pack-status [pack-id]
python -B "$TOOLS\pan_query.py" panel-log --max 80
```

## bridge.py

```powershell
powershell -File "$S\scripts\start_connector.ps1"
# Listens on 127.0.0.1:27865
# State and cache: $RUNTIME
```

## Chrome extension path

```text
%USERPROFILE%\.codex\skills\baidu-pan-connector\extension
```

## Smoke test

```powershell
python -B "$S\scripts\check_install.py"
python -B "$TOOLS\pan_task.py" health
python -B "$TOOLS\pan_query.py" list "/" --max 20
```
