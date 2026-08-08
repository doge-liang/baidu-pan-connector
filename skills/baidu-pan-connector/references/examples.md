# 使用示例（对话风格）

模式吸收自 [baidu-drive examples](https://github.com/baidu-netdisk/bdpan-storage)，命令替换为本 connector CLI。

以下 `$S` = `%USERPROFILE%\.codex\skills\baidu-pan-connector`。

---

## 安装检查

```
用户: 检查一下网盘 connector 能不能用
AI: [python $S\scripts\check_install.py]
    RESULT: PASS
    bridge OK，pan RPC OK。
```

---

## 列表

```
用户: 看看网盘根目录有什么
AI: [python $S\tools\pan_query.py list "/" --max 50]
    共 N 项：00_整理中、20_知识与出版、…
```

```
用户: 列出 /docs 下面的文件
AI: [python $S\tools\pan_query.py list "/docs" --max 200]
    …
```

---

## 搜索

```
用户: 在网盘里搜 report
AI: [python $S\tools\pan_query.py search "report" --dir "/" --max 50]
    找到 K 条，展示名称与路径。
```

---

## 建目录 + 移动（任务包）

```
用户: 在 /archive 下建 2026，把 /inbox/old.pdf 移过去并改名 archive-old.pdf
AI: [exists /archive, list /inbox]
    [写 tasks/move-archive-….json：mkdir + move]
    [向用户确认路径摘要]
    [python $S\tools\pan_task.py push … --auto --wait]
    [list /archive/2026 验收]
    已完成：/inbox/old.pdf → /archive/2026/archive-old.pdf
```

任务包片段：

```json
{
  "schema": "baidu-pan-task-pack/v1",
  "id": "move-archive-demo",
  "title": "mkdir + move",
  "tasks": [
    { "id": "m1", "op": "mkdir", "path": "/archive/2026", "risk": "low" },
    {
      "id": "mv1",
      "op": "move",
      "path": "/inbox/old.pdf",
      "dest": "/archive/2026",
      "newname": "archive-old.pdf",
      "risk": "low"
    }
  ]
}
```

---

## 删除（必须确认）

```
用户: 删掉 /tmp/scrap.pdf
AI: 将删除（进回收站）：
      /tmp/scrap.pdf
    确认执行？
用户: 确认
AI: [push delete pack --auto --wait]
    已删除（可在网盘回收站恢复）。
```

---

## 路径模糊 / 代词

```
用户: 把那个 PDF 挪到备份里
AI: 当前对话未绑定唯一 PDF。请指定完整路径，或先让我 search/list。
```

```
用户: 第 2 个
AI: （若上一轮 list 有编号）将操作：<路径2>。确认？
```

---

## 长任务进度

```
用户: 执行这个 80 条 move 任务包
AI: [push --auto --wait]
    [wait 输出 status=… counts=…]
    完成：成功 A，失败 B；失败项：…
```

---

## 上传本机文件

```
用户: 把 D:\docs\a.pdf 上传到 /inbox
AI: [check_install]
    [python $S\tools\pan_query.py upload "D:\docs\a.pdf" --dest "/inbox"]
    已上传 → /inbox/a.pdf （或秒传）
```

任务包：

```json
{
  "op": "upload",
  "local": "D:\\\\docs\\\\a.pdf",
  "dest": "/inbox",
  "newname": "a.pdf",
  "ondup": "fail",
  "risk": "medium"
}
```

扩展需 **0.5.0+**（含 `upload` op）。改代码后请在 `chrome://extensions` 点重新加载。
