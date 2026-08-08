# Baidu Pan Agent Connector（浏览器扩展 + 本机 CLI）

**定位**：百度网盘 → Agent 的 **能力 Connector（非官方）**。  
扩展只负责在已登录的 `pan.baidu.com` 上执行任务包；**决策与编排由配套 Agent + Skills / CLI 完成**。删除进回收站，可恢复。扩展**不**存储 Cookie / bdstoken。

与百度无关联；Chrome 商店文案须保留 Unofficial / 非官方。

## 组件

| 路径 | 作用 |
|---|---|
| `manifest.json` 等 | Chrome MV3 扩展（**仅**前端；勿在此目录跑 Python） |
| `../baidu-pan-tools/bridge.py` | `127.0.0.1:27865` 任务桥 + 索引 + 实况 RPC + run 状态 |
| `../baidu-pan-tools/pan_task.py` | **主控 CLI**：push / wait / status |
| `../baidu-pan-tools/pan_query.py` | 实况 list/exists/search / crawl |
| `tasks/*.json` | **私人**任务包工作区，**不进入**商店发布包 |
| `store/` | 上架文案、隐私政策、打包脚本 |

版本 **0.4.0+** 按 Connector 定位整理商店素材；**0.3.0+** 支持 `--auto` 全自动执行。

## 安装扩展（开发）

1. `chrome://extensions` → 开发者模式 → 加载本目录  
2. 打开并登录 [百度网盘](https://pan.baidu.com)  
3. 保持该页签打开（connector 依赖 content script）

## 日常：CLI / Agent 全自动下发

```bash
# 终端 1：任务桥
python scripts/baidu-pan-tools/bridge.py

# 终端 2：推送并自动执行（网盘页已开）
python scripts/baidu-pan-tools/pan_task.py push scripts/baidu-pan-ext/tasks/xxx.json --auto --wait
```

| 参数 | 含义 |
|---|---|
| `--auto` | 预核准任务；扩展静默执行，**不弹 confirm** |
| `--mode all` | 默认；含 delete/high（agent 已把关） |
| `--mode safe` | 跳过 delete/high，留给面板人工 |
| `--wait` | 轮询 `/run/status` 直到 done/failed/partial |

```bash
python scripts/baidu-pan-tools/pan_task.py status <pack-id>
python scripts/baidu-pan-tools/pan_task.py wait <pack-id>
python scripts/baidu-pan-tools/pan_task.py health
```

## 面板角色（降级）

- 观察日志与任务状态  
- 兜底：非 auto 包仍可「核准 / 执行」  
- 抓取 / 重建索引按钮仍可用；亦支持 `pan_query.py crawl-start --auto-index`

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

支持 `op`：`mkdir` / `copy` / `copy-batch` / `move` / `rename` / `delete` / `normalize-dir`。

## Chrome Web Store

1. 部署 `store/privacy-policy.html` 到公网 HTTPS（商店强制隐私政策 URL）。  
2. 打包（**不含** `tasks/`、`store/` 草稿）：

```bash
python scripts/baidu-pan-ext/store/pack.py
# → scripts/baidu-pan-ext/dist/baidu-pan-agent-connector-<ver>.zip
```

3. 打开 [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)，上传 zip；文案与权限说明见 `store/LISTING.md`、`store/PERMISSIONS.md`。  
4. 建议首次 **Unlisted**；截图至少 1 张（popup 或 pan 页面板）。  
5. 图标：`icons/icon{16,48,128}.png`；可用 `python store/gen_icons.py` 重生成。

## 注意

- Python 工具在 `baidu-pan-tools/`，**禁止**放进扩展目录（`__pycache__` / `_` 前缀路径会导致 Chrome 拒载）  
- 同一 pack id 再次 `--auto` push 会换 `push_seq` 强制重跑  
- 无 pan 页签时 run 状态为 `waiting_tab`，打开网盘后扩展会继续拉 pending 并执行  
- 发布包不得夹带私人 `tasks/*.json`  
