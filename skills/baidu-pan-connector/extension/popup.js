const light = document.getElementById("light");
const label = document.getElementById("label");
const title = document.getElementById("title");
const summary = document.getElementById("summary");
const log = document.getElementById("log");
const lines = document.getElementById("lines");

function render(view) {
  const color = ["red", "green", "blue"].includes(view.color) ? view.color : "blue";
  light.className = "light " + color;
  label.textContent = view.label || "未知状态";
  title.textContent = view.title || "等待 Agent 下发任务";
  summary.textContent = view.summary || "暂无状态摘要";
  const debugLines = Array.isArray(view.log) ? view.log : [];
  log.textContent = debugLines.length ? debugLines.join("\n") : "暂无 Debug 日志";
  lines.textContent = debugLines.length + " lines";
  log.scrollTop = log.scrollHeight;
}

async function readConnectorStatus() {
  const tabs = await chrome.tabs.query({
    url: ["https://pan.baidu.com/*", "https://yun.baidu.com/*"]
  });
  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "connector-ui-status" });
      if (response && response.ok && response.result) {
        render(response.result);
        return;
      }
    } catch (_) {}
  }

  try {
    const poll = await chrome.runtime.sendMessage({ type: "poll-now", force: false });
    render({
      color: "red",
      label: poll && poll.ok ? "缺少网盘页签" : "连接异常",
      title: "Connector 尚不能执行任务",
      summary: poll && poll.ok ? "请保持已登录的百度网盘页签打开" : (poll && poll.error) || "本机 bridge 无响应",
      log: [poll && poll.ok ? "Bridge 在线，但没有可用的 pan.baidu.com 内容脚本。" : (poll && poll.error) || "无状态响应"]
    });
  } catch (error) {
    render({
      color: "red",
      label: "扩展异常",
      title: "无法读取 Connector 状态",
      summary: String(error.message || error),
      log: [String(error.stack || error.message || error)]
    });
  }
}

readConnectorStatus();
