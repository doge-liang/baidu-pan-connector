# Permission justifications（Chrome Web Store 审核）

Single purpose: **Connect a local Agent to Baidu Netdisk so authorized task packs execute in the user’s logged-in browser session.**

| Permission | Why |
|---|---|
| `storage` | Persist task-pack state and UI status on device only (`chrome.storage.local`). |
| `downloads` | Capture only the exact short-lived dlink armed for the active task, assign it an isolated staging filename with `downloads.onDeterminingFilename`, wait for completion, then let the local bridge verify and atomically install it before removing the staging file and history entry. |
| `declarativeNetRequestWithHostAccess` | During an active web-session download only, set the documented or source-matched Netdisk `Referer` and User-Agent profile for explicitly permitted Baidu data-domain families. Profiles are tried sequentially only after the preceding request fails before writing bytes; the session rule is removed immediately afterward and never reads or changes cookies. |
| `scripting` | Execute one bundled signature function in the requesting `pan.baidu.com` tab's MAIN world. It calls same-origin `/api/gettemplatevariable`, but never evaluates the remotely returned code string; the extension applies its bundled, auditable transformation and returns only the computed signature, timestamp, numeric VIP class, and a source label. It does not read cookies or modify page state. |
| `https://pan.baidu.com/*` | Content script + same-origin Netdisk web APIs while the user is logged in. Required host for the connector. |
| `https://yun.baidu.com/*` | Alternate Baidu Netdisk web origin used by the same logged-in connector flow. |
| `https://*.pcs.baidu.com/*` | Baidu PCS upload/download data hosts used only for user-requested file transfer. |
| `https://*.baidupcs.com/*` | Baidu Netdisk download data hosts used only for user-requested file transfer. |
| `http://127.0.0.1:27865/*` | Poll the **local** Agent task bridge for pending packs and report run results. Default port of the companion CLI. |
| `http://localhost:27865/*` | Same as above when the bridge is addressed via `localhost`. |

## What reviewers should know

The MAIN-world function is bundled in `background.js` and is injected only into the tab that requested the download. Its only network call is the same-origin Netdisk `/api/gettemplatevariable` endpoint used by the current first-party web bundle; it performs no DOM writes and never returns raw signature inputs.

1. **Not a standalone consumer app.** Without a local Agent bridge, the extension cannot invent tasks; it only provides execution capability.
2. **No developer backend.** No analytics or remote command channel operated by the publisher.
3. **Unofficial.** Not affiliated with Baidu.
4. **High-risk ops** (e.g. delete) are requested only if the user’s Agent pushes such tasks; delete uses Baidu recycle bin. Operator policy belongs in Agent/Skills, not in remote servers.
5. **Package does not include** personal `tasks/*.json` workspaces used for private vault maintenance.
