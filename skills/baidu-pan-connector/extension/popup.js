const msg = document.getElementById("msg");

document.getElementById("poll").onclick = () => {
  chrome.runtime.sendMessage({ type: "poll-now", force: true }, (resp) => {
    if (chrome.runtime.lastError) {
      msg.textContent = chrome.runtime.lastError.message;
      msg.className = "err";
      return;
    }
    if (!resp) {
      msg.textContent = "无响应";
      msg.className = "err";
      return;
    }
    if (resp.error && !(resp.imported && resp.imported.length)) {
      msg.textContent = resp.error;
      msg.className = "err";
      return;
    }
    msg.textContent =
      "导入 " +
      (resp.imported || []).length +
      " · history " +
      (resp.historyCount || 0) +
      (resp.note ? " · " + resp.note : "");
    msg.className = "ok";
  });
};

document.getElementById("open").onclick = () => {
  chrome.tabs.create({ url: "https://pan.baidu.com" });
};

document.getElementById("clear").onclick = () => {
  if (!confirm("清空扩展内全部任务包？不会删除网盘文件。")) return;
  chrome.runtime.sendMessage({ type: "clear-all-packs" }, (resp) => {
    if (chrome.runtime.lastError) {
      msg.textContent = chrome.runtime.lastError.message;
      msg.className = "err";
      return;
    }
    if (resp && resp.ok) {
      msg.textContent = "已清空 " + (resp.cleared || 0) + " 个任务包";
      msg.className = "ok";
    } else {
      msg.textContent = "清空失败";
      msg.className = "err";
    }
  });
};

document.getElementById("import").onclick = () => {
  const raw = document.getElementById("json").value.trim();
  if (!raw) {
    msg.textContent = "请粘贴 JSON";
    msg.className = "err";
    return;
  }
  try {
    const pack = JSON.parse(raw);
    chrome.runtime.sendMessage({ type: "import-pack", pack }, (resp) => {
      if (resp && resp.ok) {
        msg.textContent = "已导入 " + resp.id;
        msg.className = "ok";
      } else {
        msg.textContent = "导入失败";
        msg.className = "err";
      }
    });
  } catch (e) {
    msg.textContent = "JSON 无效: " + e.message;
    msg.className = "err";
  }
};
