# Task pack reference `baidu-pan-task-pack/v1`

## Top-level fields

| Field | Required | Notes |
|---|---|---|
| `schema` | yes | `"baidu-pan-task-pack/v1"` |
| `id` | yes | Globally unique pack id |
| `title` | recommended | Human label |
| `description` | no | Free text |
| `tasks` | yes | Ordered task array |

## Task fields

| Field | Ops | Notes |
|---|---|---|
| `id` | all | Unique within pack |
| `op` | all | See table below |
| `path` | most | Source path, or mkdir target |
| `dest` | move, copy, upload, download | Destination **directory**; remote for upload, local for download |
| `newname` | move, rename, upload, download | New **filename** only |
| `risk` | all | `low` / `medium` / `high` |
| `title` | recommended | Short label for logs/UI |
| `reason` | no | Optional rationale |

Do not pre-set task `status` to `done`; `--auto` marks tasks `approved` for the extension.

## Operations

| op | Main fields | Notes |
|---|---|---|
| `mkdir` | `path` | Create directory |
| `move` | `path`, `dest`, optional `newname` | File or folder |
| `rename` | `path`, `newname` | Same-parent rename |
| `copy` | `path`, `dest` | Single copy |
| `copy-batch` | extension-specific | See existing packs if present |
| `delete` | `path` | Recycle bin; use `risk: high` |
| `upload` | `local`, `dest` or `path`, optional `newname`, `ondup` | Local file → pan via bridge+extension |
| `download` | `path`, `local` or `dest`, optional `newname`, `ondup` | Pan file → local via extension+bridge |
| `normalize-dir` | `path` (+ ext fields) | Use only when you know the semantics |

### upload

```json
{
  "id": "u1",
  "op": "upload",
  "local": "C:\\\\Users\\\\me\\\\file.pdf",
  "dest": "/remote/dir",
  "newname": "file.pdf",
  "ondup": "fail",
  "risk": "medium",
  "title": "upload file.pdf"
}
```

| Field | Required | Notes |
|---|---|---|
| `local` | yes* | Absolute path on the machine running bridge |
| `dest` | yes* | Remote **directory** |
| `path` | alt | Full remote path (instead of dest+newname) |
| `newname` | no | Defaults to local basename |
| `ondup` | no | `fail` (default) \| `overwrite` \| `newcopy` |
| `file_token` | no | Set by bridge when using RPC; normally omit |

\* Either `path` or `dest` (+ optional `newname`) required.

Flow: bridge hashes file (4MiB blocks) → extension `precreate` → PCS `superfile2` parts → `create`.

### download

```json
{
  "id": "dl1",
  "op": "download",
  "path": "/remote/dir/file.pdf",
  "dest": "D:\\downloads",
  "newname": "file.pdf",
  "ondup": "fail",
  "risk": "low",
  "title": "download file.pdf"
}
```

| Field | Required | Notes |
|---|---|---|
| `path` | yes | Absolute remote file path; directories are not recursive |
| `local` | yes* | Full absolute local target path |
| `dest` | alt | Absolute local directory (instead of `local`) |
| `newname` | no | With `dest`; defaults to remote basename |
| `ondup` | no | `fail` (default) \| `overwrite` |

\* Exactly one of `local` or `dest` is required.

Flow: extension resolves remote metadata and `dlink` → arms an exact-URL, short-lived download capture → the logged-in Pan document triggers the attachment request → Chrome assigns the requested isolated staging filename when possible → bridge imports and checks size and available MD5 → atomic replace → bridge removes the staging file and the extension removes the download-history entry. If Chrome applies a server-provided filename, the bridge additionally requires the file creation and modification times to be newer than the short-lived registration and its length to match exactly; when Baidu supplies a standard 32-character hexadecimal MD5, the bridge also verifies it before the atomic replace. Failed transfers remove staging and partial files.

## Minimal examples

### mkdir

```json
{
  "schema": "baidu-pan-task-pack/v1",
  "id": "mkdir-demo-001",
  "title": "mkdir demo",
  "tasks": [
    {
      "id": "m1",
      "op": "mkdir",
      "path": "/example/new-folder",
      "risk": "low",
      "title": "create folder"
    }
  ]
}
```

### move (+ optional rename)

```json
{
  "schema": "baidu-pan-task-pack/v1",
  "id": "move-demo-001",
  "title": "move demo",
  "tasks": [
    {
      "id": "mv1",
      "op": "move",
      "path": "/example/a/file.pdf",
      "dest": "/example/b",
      "newname": "file-renamed.pdf",
      "risk": "low",
      "title": "move file"
    }
  ]
}
```

### delete (confirm before push)

```json
{
  "schema": "baidu-pan-task-pack/v1",
  "id": "delete-demo-confirm",
  "title": "delete demo — require human confirm",
  "tasks": [
    {
      "id": "d1",
      "op": "delete",
      "path": "/example/trash-me.pdf",
      "risk": "high",
      "title": "delete"
    }
  ]
}
```

## CLI

```powershell
python path\to\baidu-pan-tools\pan_task.py push pack.json --auto --wait
python path\to\baidu-pan-tools\pan_task.py push pack.json --auto --mode safe --wait
python path\to\baidu-pan-tools\pan_task.py status <pack-id>
```

`--mode safe` holds `delete` and `risk=high` for the extension panel.
