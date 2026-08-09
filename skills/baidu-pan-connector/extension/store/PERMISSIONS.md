# Permission justifications（Chrome Web Store 审核）

Single purpose: **Connect a local Agent to Baidu Netdisk so authorized task packs execute in the user’s logged-in browser session.**

| Permission | Why |
|---|---|
| `storage` | Persist task-pack state and UI status on device only (`chrome.storage.local`). |
| `https://pan.baidu.com/*` | Content script + same-origin Netdisk web APIs while the user is logged in. Required host for the connector. |
| `http://127.0.0.1:27865/*` | Poll the **local** Agent task bridge for pending packs and report run results. Default port of the companion CLI. |
| `http://localhost:27865/*` | Same as above when the bridge is addressed via `localhost`. |

## What reviewers should know

1. **Not a standalone consumer app.** Without a local Agent bridge, the extension cannot invent tasks; it only provides execution capability.
2. **No developer backend.** No analytics or remote command channel operated by the publisher.
3. **Unofficial.** Not affiliated with Baidu.
4. **High-risk ops** (e.g. delete) are requested only if the user’s Agent pushes such tasks; delete uses Baidu recycle bin. Operator policy belongs in Agent/Skills, not in remote servers.
5. **Package does not include** personal `tasks/*.json` workspaces used for private vault maintenance.
