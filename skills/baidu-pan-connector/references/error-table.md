# 错误 → 用户提示

Connector / bridge 侧常见情况（非 bdpan errno 全集）。

| 现象 | 用户提示 | 建议 |
|---|---|---|
| 无法连接 27865 | 本机任务桥未启动 | `python …/tools/bridge.py` 后重试 |
| health ok，RPC timeout / waiting_tab | 扩展未加载或未打开登录页 | 加载 `extension/`，打开 pan.baidu.com |
| list/exists 路径不存在 | 路径错误或已移动 | search 关键词；list 父目录 |
| move FAIL 源不存在 | 源文件/夹已不在该路径 | 重新 list/search |
| move FAIL 目标不存在 | 目标目录未创建 | 先 `mkdir` 再 move |
| move FAIL 同名冲突 | 目标已有同名 | 换 `newname` 或先 rename/delete |
| delete FAIL | 路径无效或权限 | exists 复核；是否已在回收站 |
| pack partial | 部分任务失败 | `pan_task.py status` 看 FAIL id；修路径后换新 pack id 再 push |
| crawl 过慢/失败 | 全盘抓取重 | 用户确认是否继续；可 crawl-stop |
| index rebuild 无 vault | 未配置索引工程路径 | 可选 `BAIDU_PAN_VAULT` 或 `bridge --vault`；纯整理可不做索引 |

## 用户取消

任意时刻用户表示取消 → 不 push 新包；已在跑的 pack 可说明「已下发部分可能仍在执行」，询问是否需要对照 status。

## 与 baidu-drive errno 对照

官方 skill 对 `bdpan` 有 errno 表（提取码错误、分享失效等）。**本 connector 不做转存/分享**；若用户要处理分享链接，引导使用 baidu-drive。
