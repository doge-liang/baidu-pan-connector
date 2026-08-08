# 安装与检查（Baidu Pan Agent Connector）

> 触发规则、确认矩阵、安全须知等 Agent 行为规范吸收自公开 skill  
> [baidu-drive](https://github.com/baidu-netdisk/bdpan-storage)（`npx skills add … --skill baidu-drive`），  
> 传输层为本 skill 自带的扩展 + bridge，而非 `bdpan` CLI。

Skill 目录（本机）：

```text
~/.codex/skills/baidu-pan-connector/
  extension/     ← Chrome「加载已解压的扩展程序」选这里
  tools/         ← bridge / pan_task / pan_query
  tasks/         ← 你写的任务包 JSON
  scripts/check_install.py
```

Windows 绝对路径示例：

```text
C:\Users\<你>\.codex\skills\baidu-pan-connector\extension
```

## 一次性安装

### 1. 启动任务桥（保持运行）

```powershell
python "$env:USERPROFILE\.codex\skills\baidu-pan-connector\tools\bridge.py"
```

### 2. 安装 Chrome 扩展

1. 打开 `chrome://extensions`
2. 打开 **开发者模式**
3. **加载已解压的扩展程序**
4. 选择目录：

```text
%USERPROFILE%\.codex\skills\baidu-pan-connector\extension
```

5. 确认扩展启用，名称类似 *Baidu Pan Agent Connector (Unofficial)*

### 3. 打开网盘页签

1. 打开 https://pan.baidu.com 并登录  
2. **保持该页签打开**（connector 依赖 content script）

### 4. 运行安装检查

```powershell
python "$env:USERPROFILE\.codex\skills\baidu-pan-connector\scripts\check_install.py"
```

期望：

- `[OK] extension/ present`
- `[OK] tools/ … present`
- `[OK] bridge health ok`
- `[OK] pan RPC responded`（若第 5 步是 `[!!]`，回到步骤 2–3）

## 给 Agent 的固定提示词（可复制）

```text
使用 baidu-pan-connector skill 操作百度网盘。
开始前先运行安装检查：
  python %USERPROFILE%\.codex\skills\baidu-pan-connector\scripts\check_install.py
若 FAIL：按输出启动 bridge、用 Chrome 加载 extension 目录、打开已登录的 pan.baidu.com。
通过后再 list/search 或写任务包 push --auto --wait。
扩展目录（仅加载用）：
  %USERPROFILE%\.codex\skills\baidu-pan-connector\extension
CLI：
  %USERPROFILE%\.codex\skills\baidu-pan-connector\tools\
```

## 日常命令

```powershell
$S = "$env:USERPROFILE\.codex\skills\baidu-pan-connector"
python "$S\tools\pan_task.py" health
python "$S\tools\pan_query.py" list "/" --max 20
python "$S\tools\pan_task.py" push "$S\tasks\my.json" --auto --wait
```

## 注意

- 不要在 `extension/` 里跑 Python（避免 `__pycache__` 导致 Chrome 拒载）
- 任务包写在 skill 的 `tasks/`，不要塞进扩展目录再打包上架
- 本 connector **不**提供本机文件上传 API
