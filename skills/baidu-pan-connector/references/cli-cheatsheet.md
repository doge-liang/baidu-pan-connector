# CLI cheatsheet

Bundled under the skill (preferred):

```powershell
$S = "$env:USERPROFILE\.codex\skills\baidu-pan-connector"
$TOOLS = "$S\tools"
```

Default bridge: `http://127.0.0.1:27865`.

## Install check

```powershell
python "$S\scripts\check_install.py"
```

## pan_task.py

```powershell
python "$TOOLS\pan_task.py" health
python "$TOOLS\pan_task.py" push <pack.json> --auto --wait
python "$TOOLS\pan_task.py" push <pack.json> --auto --mode safe --wait
python "$TOOLS\pan_task.py" status [pack-id]
python "$TOOLS\pan_task.py" wait <pack-id>
python "$TOOLS\pan_task.py" drop --all    # clears pending queue; use carefully
```

## pan_query.py

```powershell
python "$TOOLS\pan_query.py" list "/"
python "$TOOLS\pan_query.py" list "/path" --max 200
python "$TOOLS\pan_query.py" list "/path" --recursive --max 500
python "$TOOLS\pan_query.py" exists "/path"
python "$TOOLS\pan_query.py" search "keyword" --dir "/" --max 50
python "$TOOLS\pan_query.py" upload "D:\local\file.pdf" --dest "/remote/dir"
python "$TOOLS\pan_query.py" upload "D:\local\file.pdf" --path "/remote/dir/file.pdf" --ondup overwrite
python "$TOOLS\pan_query.py" crawl-start
python "$TOOLS\pan_query.py" crawl-start --auto-index
python "$TOOLS\pan_query.py" crawl-status
python "$TOOLS\pan_query.py" crawl-stop
python "$TOOLS\pan_query.py" crawl-upload-rebuild
python "$TOOLS\pan_query.py" index-status
python "$TOOLS\pan_query.py" pack-status [pack-id]
python "$TOOLS\pan_query.py" panel-log --max 80
```

## bridge.py

```powershell
python "$TOOLS\bridge.py"
# Listens on 127.0.0.1:27865
# State: $S\state\   Cache: $S\crawl-cache\
```

## Chrome extension path

```text
%USERPROFILE%\.codex\skills\baidu-pan-connector\extension
```

## Smoke test

```powershell
python "$S\scripts\check_install.py"
python "$TOOLS\pan_task.py" health
python "$TOOLS\pan_query.py" list "/" --max 20
```
