# Sources & attribution

## Upstream inspiration

**baidu-drive** skill from Baidu Netdisk / community packaging:

- Repository: https://github.com/baidu-netdisk/bdpan-storage
- Skill path: `skills/baidu-drive/`
- Install: `npx skills add https://github.com/baidu-netdisk/bdpan-storage/skills --skill baidu-drive`
- Reviewed version: **v1.7.3** (local clone at absorb time)

### Absorbed (patterns only)

- Explicit TRIGGER / DO NOT TRIGGER / conversation continuity
- Risk-tier confirmation matrix + ambiguity / cancel rules
- First-use safety notes (backup, human review, no token leakage)
- Ordered preflight before operations
- Verify-before-write (exists/list then mutate)
- Dialogue-style examples and error→user-message tables
- Progress reporting for long-running jobs

### Not absorbed (different product)

- `bdpan` OpenAPI CLI and `/apps/bdpan` path jail
- OAuth `login.sh` / token file handling
- Upload / download / transfer / share command flows
- Agent memory backup scripts

## This skill’s own stack

Chrome MV3 extension + Python bridge originally developed for local pan automation; packaged under this skill’s `extension/` and `tools/`.

The download design follows Baidu's official developer-center description that file metadata can provide a temporary `dlink`; authenticated browser-session integration and local streaming are implemented by this connector rather than copied from the upstream `bdpan` command flow:

- https://developer.baidu.com/question/detail.html?id=179

Baidu's developer Q&A also records that a `dlink` request must carry its required User-Agent field; a normal browser User-Agent is not equivalent:

- https://cloud.baidu.com/ask/141
- https://cloud.baidu.com/ask/148

The logged-in web-session compatibility path uses the Netdisk page's short-lived `sign1`/`sign3` signature and same-origin `/api/download` contract. These references were used to cross-check the request fields and signature flow; no code was copied wholesale:

- https://greasyfork.org/sr/scripts/27886-baidupandownloadhelper/code
- https://gist.github.com/Vesnica/c34c0f492183de741827

The page-context attachment route uses Chrome's documented `downloads.onDeterminingFilename` event to assign the connector's isolated staging filename without inspecting cookie values:

- https://developer.chrome.com/docs/extensions/reference/api/downloads

Version 0.7.14 was cross-checked against the public Netdisk web bundle served by the 2026-08-04 page build. That first-party bundle calls `/api/gettemplatevariable`, evaluates the returned `sign2` function, and calls `/api/download` with GET plus `fidlist`, `type`, `vip`, `sign`, and `timestamp`:

- https://nd-static.bdstatic.com/m-static/v20-main/home/js/home.ecf8d7f2.js
- https://nd-static.bdstatic.com/m-static/v20-main/home/js/chunk-vendors.ee3fc6f7.js

The connector intentionally does not evaluate the remote `sign2` source because Manifest V3 requires extension code to be bundled locally; Chrome explicitly treats fetching a resource and executing it directly as remote hosted code:

- https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
