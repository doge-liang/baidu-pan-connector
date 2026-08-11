# Baidu Pan Agent Connector（浏览器扩展 + 本机 CLI）

**定位**：百度网盘 → Agent 的 **能力 Connector（非官方）**。
扩展只负责在已登录的 `pan.baidu.com` 上执行任务包；**决策与编排由配套 Agent + Skills / CLI 完成**。删除进回收站，可恢复。扩展**不**存储 Cookie / bdstoken。

与百度无关联；Chrome 商店文案须保留 Unofficial / 非官方。

## 组件

| 路径 | 作用 |
|---|---|
| `manifest.json` 等 | Chrome MV3 扩展（**仅**前端；勿在此目录跑 Python） |
| `../tools/bridge.py` | `127.0.0.1:27865` 任务桥 + 索引 + 实况 RPC + run 状态 |
| `../tools/pan_task.py` | **主控 CLI**：push / wait / status |
| `../tools/pan_query.py` | 实况 list/exists/search / crawl / upload / download |
| `%USERPROFILE%/.codex/state/baidu-pan-connector/tasks/*.json` | **私人**任务包工作区，位于源码外 |
| `store/` | 上架文案、隐私政策、打包脚本 |

版本 **0.6.0+** 使用只读 Connector 界面：三色状态灯、当前任务摘要和 Debug 日志；**0.3.0+** 支持 `--auto` 全自动执行。版本 **0.6.1+** 会在扩展重载使旧页面上下文失效时停止轮询，并提示刷新页面。版本 **0.6.2+** 统一使用独立仓库与外部运行状态目录。版本 **0.7.14+** 按当前网页前端协议，在发起任务的网盘页主世界调用 `/api/gettemplatevariable`，使用扩展内置、可审计的等价算法处理实时签名输入，并以 GET 请求调用 `/api/download`；扩展不会执行服务端下发的代码字符串，旧 `yunData` 和 HTML 解析仅作为兼容回退。取得 dlink 后，在登录中的网盘文档内触发隐藏子框架导航，并用短时、精确 URL 匹配的 `downloads.onDeterminingFilename` 捕获附件。若页面上下文未产生附件，再依次尝试浏览器 UA、字面值 `netdisk`、字面值 `pan.baidu.com`、PCS 兼容 UA 和最多 4 MiB 的 bridge 顺序分块流。所有成功路径最终均由 bridge 校验大小与可用 MD5 并原子落盘。

## 安装扩展（开发）

1. `chrome://extensions` → 开发者模式 → 加载本目录
2. 打开并登录 [百度网盘](https://pan.baidu.com)
3. 保持该页签打开（connector 依赖 content script）

## 日常：CLI / Agent 全自动下发

```powershell
$S = Join-Path $env:USERPROFILE ".codex\skills\baidu-pan-connector"
$TASKS = Join-Path $env:USERPROFILE ".codex\state\baidu-pan-connector\tasks"

# 终端 1：任务桥
powershell -File "$S\scripts\start_connector.ps1"

# 终端 2：推送并自动执行（网盘页已开）
python -B "$S\tools\pan_task.py" push "$TASKS\xxx.json" --auto --wait
```

| 参数 | 含义 |
|---|---|
| `--auto` | 预核准任务；扩展静默执行，**不弹 confirm** |
| `--mode all` | 默认；含 delete/high（agent 已把关） |
| `--mode safe` | 跳过 delete/high；由 Agent 完成确认后重新下发明确授权的任务 |
| `--wait` | 轮询 `/run/status` 直到 done/failed/partial |

```powershell
python -B "$S\tools\pan_task.py" status <pack-id>
python -B "$S\tools\pan_task.py" wait <pack-id>
python -B "$S\tools\pan_task.py" health
```

## 界面角色

- 收起时只显示红、绿或蓝状态灯、当前任务标题和状态摘要
- 展开后显示 Connector 状态与 Debug 日志
- 不提供核准、驳回、执行、导入、清空、抓取或索引维护按钮
- 所有控制和用户确认由 Agent / Skills / CLI 统一完成

## 任务包 `baidu-pan-task-pack/v1`

```json
{
  "schema": "baidu-pan-task-pack/v1",
  "id": "unique-pack-id",
  "title": "…",
  "tasks": [
    { "id": "m1", "op": "move", "path": "/源", "dest": "/目标目录", "newname": "名", "risk": "low" },
    { "id": "d1", "op": "delete", "path": "/路径", "risk": "medium" }
  ]
}
```

CLI `--auto` 时 bridge 写入 `auto` / `auto_policy` / `push_seq`；扩展按 `push_seq` 覆盖导入并执行。

支持 `op`：`mkdir` / `copy` / `copy-batch` / `move` / `rename` / `delete` / `upload` / `download` / `normalize-dir`。

## Chrome Web Store

1. 部署 `store/privacy-policy.html` 到公网 HTTPS（商店强制隐私政策 URL）。
2. 打包（**不含** `tasks/`、`store/` 草稿）：

```powershell
python store/pack.py
# → dist/baidu-pan-agent-connector-<ver>.zip
```

3. 打开 [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)，上传 zip；文案与权限说明见 `store/LISTING.md`、`store/PERMISSIONS.md`。
4. 建议首次 **Unlisted**；截图至少 1 张（popup 或 pan 页面板）。
5. 图标：`icons/icon{16,48,128}.png`；可用 `python store/gen_icons.py` 重生成。

## 注意

- Python 工具在 `../tools/`，**禁止**放进扩展目录（`__pycache__` / `_` 前缀路径会导致 Chrome 拒载）
- 同一 pack id 再次 `--auto` push 会换 `push_seq` 强制重跑
- 无 pan 页签时 run 状态为 `waiting_tab`，打开网盘后扩展会继续拉 pending 并执行
- 发布包不得夹带私人 `tasks/*.json`
