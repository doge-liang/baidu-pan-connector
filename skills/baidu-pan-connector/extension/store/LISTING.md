# Chrome Web Store 上架文案

定位：**Baidu Pan → Agent 的能力 Connector**。扩展只提供执行面；决策、规划、任务生成由配套 Agent + Skills 完成。

**非官方**，与百度无关联。

---

## 基本信息（提交时填写）

| 字段 | 建议值 |
|---|---|
| 名称 | `Baidu Pan Agent Connector (Unofficial)` |
| 语言 | English（主）+ 可另加简体中文 |
| 类别 | Productivity / Developer Tools（二选一；偏 Agent 工具选 Developer Tools） |
| 可见性 | 建议先 **Unlisted**，自测通过后再 Public |
| 定价 | Free |

---

## Short description（≤132 字符，英文）

```
Unofficial Baidu Pan → Agent connector. Extension only executes task packs; your local Agent + Skills decide what to do.
```

字数约 118。中文备选（若商店语言为中文）：

```
非官方「百度网盘 → Agent」连接器。扩展只执行任务包；决策与编排由本机 Agent + Skills 完成。
```

---

## Detailed description（英文主文案，可粘贴）

```
Baidu Pan Agent Connector (Unofficial)

This extension is a capability connector between Baidu Netdisk (pan.baidu.com) and a local Agent toolchain. It does not plan, score, or invent file operations on its own.

What it does
• Runs only when you are logged into pan.baidu.com in Chrome
• Receives structured task packs (JSON) from a local Agent bridge on 127.0.0.1:27865
• Executes disclosed operations such as list / mkdir / move / rename / copy / delete (delete uses Baidu recycle bin)
• Shows a lightweight panel for status, fallback import, and observation

What it does NOT do
• It is not an official Baidu product and is not affiliated with Baidu
• It does not ship a cloud Agent or remote control service
• It does not call home to the developer; Agent traffic stays on your machine via localhost
• Without a companion Agent (bridge + Skills / CLI), the extension has nothing useful to execute

How to use (high level)
1. Install this extension
2. Open and log in to https://pan.baidu.com
3. Run your local Agent stack (task bridge on port 27865 by default)
4. Have the Agent push a task pack; the connector executes and reports status

Security model
• Capability-only: the Agent decides; the extension executes in your browser session
• Prefer reviewing high-risk packs (especially delete) in your Agent/Skills policy before auto mode
• Do not install untrusted Agents that can push task packs to your local bridge

Single purpose
Connect a local Agent to Baidu Netdisk so authorized task packs can be executed in a logged-in browser session.

Disclaimer
Unofficial software. Use of Baidu Netdisk is subject to Baidu’s terms. You are responsible for operations performed by Agents you run.
```

### 简体中文详细说明（可选第二语言）

```
百度网盘 Agent Connector（非官方）

本扩展是「百度网盘 ↔ 本机 Agent」之间的能力连接器，本身不做规划与决策。

能做什么
• 仅在你已登录 pan.baidu.com 时工作
• 从本机任务桥（默认 127.0.0.1:27865）接收结构化任务包
• 执行 list / mkdir / move / rename / copy / delete 等（删除走网盘回收站）
• 提供红、绿、蓝连接状态、当前任务摘要和 Debug 日志

不做什么
• 非百度官方产品，与百度无关联
• 不内置云端 Agent，不提供远程控制服务
• 不向开发者服务器回传数据；与 Agent 的通信默认只走本机 localhost
• 没有配套 Agent + Skills / CLI 时，扩展没有可执行的业务逻辑

安全模型
• 扩展只提供能力；调用方是你信任的本机 Agent
• 高风险操作（尤其删除）应在 Agent / Skills 策略层把关
• 不要让不可信程序向本机任务桥推送任务包

单一用途
在已登录的浏览器会话中，把本机 Agent 下发的任务包落到百度网盘 API 执行。
```

---

## 商店素材路径

| 素材 | 文件 |
|---|---|
| 图标 128 | `../icons/icon128.png` |
| 图标 48 / 16 | `../icons/icon48.png` / `icon16.png` |
| 小宣传图 440×280 | `../icons/promo-440x280.png` |
| 截图 | 需你本机拍 1–5 张（见下方） |
| 隐私政策 | `privacy-policy.html`（**必须**部署为公网 HTTPS URL） |

### 截图建议（至少 1 张，1280×800 或 640×400）

1. 已登录 `pan.baidu.com`，右上角 connector 面板可见
2. 扩展 popup：三色状态灯、当前任务摘要与 Debug 日志
3. （可选）Agent CLI push 与面板状态对照

可用系统截图工具；勿在截图中暴露 Cookie、完整账号邮箱或大量隐私路径。

---

## 权限声明（审核问卷用短句）

见 `PERMISSIONS.md`。

---

## 隐私做法勾选建议（Data safety / privacy practices）

| 问题倾向 | 建议答法 |
|---|---|
| 是否收集用户数据发到开发者服务器 | **否** |
| 是否出售用户数据 | **否** |
| 是否用于与单一用途无关的目的 | **否** |
| 是否传输到第三方（除用户主动使用的服务） | 仅 **Baidu pan.baidu.com**（用户自己的会话）与 **本机 localhost 桥** |
| Personally identifiable info | 不主动收集；任务包路径由用户/Agent 提供，仅本地 storage |
| Authentication | 不存储密码；使用用户已登录页面的会话能力 |
| Remote code | **否** |

---

## 提交前检查清单

- [ ] 已用 `python store/pack.py` 生成 **不含 tasks/** 的 zip
- [ ] 本地加载 zip 解压目录，确认扩展可加载
- [ ] `privacy-policy.html` 已放到公网 HTTPS，提交页填该 URL
- [ ] 开发者账号注册费已付，联系邮箱可用
- [ ] 文案含 **Unofficial / 非官方**
- [ ] 建议先 **Unlisted** 发布
- [ ] 说明「必须配套 local Agent」——避免被当成残缺消费级网盘工具
