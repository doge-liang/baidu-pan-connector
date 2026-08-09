# 安全须知与设计笔记

## 首次使用时向用户展示

1. 请**备份**网盘重要数据。
2. AI Agent 行为不可预测，请**人工审核**高风险指令（删除、大批量移动）。
3. 本 connector **不**保存 Cookie / bdstoken；登录态只在浏览器已打开的 `pan.baidu.com` 页签中。
4. 勿在不可信环境操作已登录网盘页签；用毕可关闭页签或退出网盘网页登录。
5. 切勿在对话或仓库中粘贴任何网盘 Cookie、token 或完整授权响应。

（吸收自 [baidu-drive](https://github.com/baidu-netdisk/bdpan-storage) 的安全提示风格，机制改为浏览器会话而非 OAuth CLI。）

## 与官方 baidu-drive 的边界

| | baidu-pan-connector（本 skill） | baidu-drive（官方 skill） |
|---|---|---|
| 仓库 | 本地打包；CLI 在 `tools/` | [baidu-netdisk/bdpan-storage](https://github.com/baidu-netdisk/bdpan-storage) |
| 通道 | Chrome 扩展 + 本机 bridge | `bdpan` OpenAPI CLI |
| 路径 | 账号可见的**全树**绝对路径 | 通常限 `/apps/bdpan/` |
| 上传本地文件 | **有**（`upload` + bridge register） | 有 |
| 下载本地 / 转存 / 分享 | **无** | 有 |
| 记忆备份 | 无 | 有 |

本机上传用本 skill 的 `upload`。下载到本地、转存分享链接、生成分享：用 **baidu-drive** 或网页。

## Agent 硬约束

1. 禁止读取/打印浏览器 Cookie 或任何 token 文件。
2. 禁止在 `extension/` 目录内运行 Python（避免 `__pycache__` 导致 Chrome 拒载）。
3. 删除、覆盖性大批量 move：必须先列出影响范围并取得用户确认。
4. 全盘 crawl / 索引重建：仅当用户明确要求。
5. 用户说「算了 / 不要了 / 取消」→ 立即停止，不再 push 新任务包。
