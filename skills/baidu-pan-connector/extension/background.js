// 任务桥 connector：轮询 pending/history，导入 storage；auto 包自动触发 content 执行。
// CLI 主控：python -B tools/pan_task.py push <runtime-task.json> --auto --wait

const BRIDGE = "http://127.0.0.1:27865";
// Keep the connector responsive without continuously reparsing and rewriting the
// complete task history. The previous 2.5 s full-history loop could keep a Pan
// tab, the service worker, and Chrome storage busy for hours after a failed batch.
const POLL_MS = 10000;
const DOWNLOAD_POLL_MS = 500;
const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const PAGE_DOWNLOAD_CAPTURE_TIMEOUT_MS = 20 * 1000;
const DOWNLOAD_STREAM_CHUNK_BYTES = 4 * 1024 * 1024;
const WEB_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const ERROR_TEXT_MAX_CHARS = 800;
const DOWNLOAD_HEADER_RULE_IDS = Array.from({ length: 16 }, (_, index) => 9700 + index);
const DOWNLOAD_HEADER_DOMAINS = [
  "pcs.baidu.com",
  "baidupcs.com",
  "pan.baidu.com",
  "yun.baidu.com"
];
// /api/filemetas yields a web-session PCS link rather than an OAuth OpenAPI
// link. The PCS endpoint expects the Netdisk client compatibility UA.
const DOWNLOAD_WEB_USER_AGENT =
  "netdisk;2.2.51.6;netdisk;10.0.63;PC;android-android";
const DOWNLOAD_HEADER_PROFILES = [
  {
    name: "browser",
    userAgent: "",
    referer: "https://pan.baidu.com/disk/main"
  },
  {
    name: "legacy-netdisk",
    userAgent: "netdisk",
    referer: "http://pan.baidu.com/disk/home"
  },
  {
    name: "openapi-pan",
    userAgent: "pan.baidu.com",
    referer: "https://pan.baidu.com/disk/main"
  },
  {
    name: "pcs-netdisk",
    userAgent: DOWNLOAD_WEB_USER_AGENT,
    referer: "https://pan.baidu.com/disk/main"
  }
];
const pageDownloadCaptures = new Map();

function compactError(value, maxChars = ERROR_TEXT_MAX_CHARS) {
  const text = String(value && (value.message || value) || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 20)) + " …[diagnostic truncated]";
}

async function resolvePageDownloadContextInMainWorld() {
  function firstValue(sources, names) {
    for (const source of sources) {
      if (!source) continue;
      for (const name of names) {
        try {
          const value = source[name];
          if (value != null && value !== "") return value;
        } catch (_) {}
      }
    }
    return "";
  }
  function localValue(name) {
    try {
      if (window.locals && typeof window.locals.get === "function") {
        return window.locals.get(name);
      }
      if (window.locals && window.locals[name] != null) return window.locals[name];
    } catch (_) {}
    return "";
  }
  function sign2(key, text) {
    const box = Array.from({ length: 256 }, (_, index) => index);
    const keyCodes = Array.from({ length: 256 }, (_, index) =>
      key.charCodeAt(index % key.length)
    );
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + box[i] + keyCodes[i]) % 256;
      [box[i], box[j]] = [box[j], box[i]];
    }
    let i = 0;
    j = 0;
    let output = "";
    for (let offset = 0; offset < text.length; offset++) {
      i = (i + 1) % 256;
      j = (j + box[i]) % 256;
      [box[i], box[j]] = [box[j], box[i]];
      output += String.fromCharCode(
        text.charCodeAt(offset) ^ box[(box[i] + box[j]) % 256]
      );
    }
    return output;
  }

  let templateError = "";
  try {
    const fields = JSON.stringify(["sign1", "sign2", "sign3", "timestamp"]);
    const response = await fetch(
      "/api/gettemplatevariable?fields=" + encodeURIComponent(fields),
      { credentials: "same-origin", cache: "no-store" }
    );
    const payload = await response.json();
    if (!response.ok || Number(payload && payload.errno) !== 0 || !payload.result) {
      throw new Error("template variable errno=" + String(payload && payload.errno));
    }
    const data = payload.result;
    const timestamp = Number(data.timestamp);
    if (
      !data.sign1 ||
      !data.sign2 ||
      !data.sign3 ||
      !Number.isSafeInteger(timestamp) ||
      timestamp <= 0
    ) {
      throw new Error("template download context incomplete");
    }
    const locals = window.locals || {};
    const userInfo = locals.userInfo || {};
    const vip = Number(
      userInfo.vipType ??
        userInfo.vip_type ??
        userInfo.vip_identity ??
        locals.vipType ??
        0
    );
    return {
      ok: true,
      // The first-party page evaluates the returned sign2 source. The
      // extension deliberately does not execute remote code; it applies the
      // audited, bundled equivalent to the fresh sign1/sign3 inputs instead.
      sign: btoa(sign2(String(data.sign3), String(data.sign1))),
      timestamp,
      vip: Number.isFinite(vip) ? vip : 0,
      source: "template-variable"
    };
  } catch (error) {
    templateError = String(error && (error.message || error)).slice(0, 120);
  }

  // Compatibility fallback for historical pages that still expose yunData.
  const yunData = window.yunData || null;
  let nestedContext = null;
  try {
    if (yunData && typeof yunData.getContext === "function") {
      nestedContext = yunData.getContext();
    }
  } catch (_) {}
  const sources = [yunData, nestedContext];
  const sign1 = String(
    firstValue(sources, ["sign1", "SIGN1"]) || localValue("sign1") || ""
  );
  const sign3 = String(
    firstValue(sources, ["sign3", "SIGN3"]) || localValue("sign3") || ""
  );
  const timestamp = Number(
    firstValue(sources, ["timestamp", "TIMESTAMP"]) || localValue("timestamp") || 0
  );
  if (!sign1 || !sign3 || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return {
      ok: false,
      error: "main-world download context unavailable; " + templateError
    };
  }
  return {
    ok: true,
    sign: btoa(sign2(sign3, sign1)),
    timestamp,
    vip: 0,
    source: "legacy-yundata"
  };
}

async function getPageDownloadContextFromMainWorld(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (!Number.isInteger(tabId)) throw new Error("页面 tab id 缺失");
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: resolvePageDownloadContextInMainWorld
  });
  const result = results && results[0] && results[0].result;
  if (!result || !result.ok) {
    throw new Error(String((result && result.error) || "页面主世界签名读取失败"));
  }
  return result;
}

function validateDownloadUrl(rawUrl) {
  const url = new URL(String(rawUrl || ""));
  const host = url.hostname.toLowerCase();
  const allowed =
    url.protocol === "https:" &&
    (host === "pan.baidu.com" ||
      host === "yun.baidu.com" ||
      host.endsWith(".pcs.baidu.com") ||
      host.endsWith(".baidupcs.com"));
  if (!allowed) {
    throw new Error("拒绝非百度网盘数据域下载地址 host=" + host);
  }
  return {
    url: url.href,
    host,
    queryKeys: Array.from(new Set(url.searchParams.keys())).sort()
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function installDownloadHeaderRules(candidates, profile) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) {
    throw new Error("Chrome 缺少 declarativeNetRequest，需重新加载 0.7.15+ 扩展");
  }
  // Each redirect is a new request. Keep the rules on the complete, explicitly
  // permitted Baidu data-domain families so CDN redirects retain the headers.
  const hosts = Array.from(
    new Set([...DOWNLOAD_HEADER_DOMAINS, ...candidates.map((candidate) => candidate.host)])
  ).slice(0, DOWNLOAD_HEADER_RULE_IDS.length);
  const requestHeaders = [
    {
      header: "Referer",
      operation: "set",
      value: profile.referer
    }
  ];
  if (profile.userAgent) {
    requestHeaders.push({
      header: "User-Agent",
      operation: "set",
      value: profile.userAgent
    });
  }
  const rules = hosts.map((host, index) => ({
    id: DOWNLOAD_HEADER_RULE_IDS[index],
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders
    },
    condition: {
      requestDomains: [host]
    }
  }));
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: DOWNLOAD_HEADER_RULE_IDS,
    addRules: rules
  });
  return rules.map((rule) => rule.id);
}

async function removeDownloadHeaderRules(ruleIds) {
  if (!ruleIds || !ruleIds.length || !chrome.declarativeNetRequest) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
  } catch (_) {}
}

async function waitForNativeDownload(downloadId) {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items && items[0];
    if (!item) throw new Error("Chrome 下载记录不存在 id=" + downloadId);
    if (item.state === "complete") return item;
    if (item.state === "interrupted") {
      let finalHost = "unknown";
      try {
        if (item.finalUrl) finalHost = new URL(item.finalUrl).hostname;
      } catch (_) {}
      throw new Error(
        "Chrome 下载中断 " + (item.error || "unknown") + " finalHost=" + finalHost
      );
    }
    await wait(DOWNLOAD_POLL_MS);
  }
  throw new Error("Chrome 下载超时 id=" + downloadId);
}

async function removeNativeDownload(downloadId, state) {
  if (downloadId == null) return;
  try {
    if (state === "in_progress") await chrome.downloads.cancel(downloadId);
  } catch (_) {}
  try {
    await chrome.downloads.removeFile(downloadId);
  } catch (_) {}
  try {
    await chrome.downloads.erase({ id: downloadId });
  } catch (_) {}
}

function downloadItemMatchesCapture(item, capture) {
  for (const value of [item && item.url, item && item.finalUrl]) {
    if (!value) continue;
    try {
      if (new URL(value).href === capture.source.url) return true;
    } catch (_) {}
  }
  return false;
}

// Keep this listener registered at service-worker initialization. A capture is
// armed only for one exact, validated Baidu data URL and expires quickly, so an
// unrelated user download cannot be renamed into the connector staging area.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  for (const capture of pageDownloadCaptures.values()) {
    if (capture.state !== "armed" || Date.now() >= capture.expiresAt) continue;
    if (!downloadItemMatchesCapture(item, capture)) continue;
    capture.downloadId = item.id;
    capture.state = "captured";
    suggest({
      filename: "baidu-pan-connector/" + capture.token + ".download",
      conflictAction: "overwrite"
    });
    return;
  }
});

async function cancelPageDownloadCapture(captureId) {
  const capture = pageDownloadCaptures.get(String(captureId || ""));
  if (!capture) return;
  pageDownloadCaptures.delete(capture.id);
  let state = null;
  if (capture.downloadId != null) {
    try {
      const items = await chrome.downloads.search({ id: capture.downloadId });
      state = items && items[0] && items[0].state;
    } catch (_) {}
  }
  await removeNativeDownload(capture.downloadId, state);
  await removeDownloadHeaderRules(capture.headerRuleIds);
}

async function preparePageDownloadCapture(message) {
  const token = String(message.token || "");
  const expectedSize = Number(message.expectedSize);
  const source = validateDownloadUrl(message.dlink);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    throw new Error("download token 非法");
  }
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error("download expectedSize 非法");
  }
  for (const capture of pageDownloadCaptures.values()) {
    if (capture.state === "armed" && Date.now() < capture.expiresAt) {
      throw new Error("已有页面下载等待捕获，请稍后重试");
    }
  }

  const id = crypto.randomUUID();
  const headerRuleIds = await installDownloadHeaderRules(
    [source],
    DOWNLOAD_HEADER_PROFILES[0]
  );
  const capture = {
    id,
    token,
    expectedSize,
    source,
    headerRuleIds,
    downloadId: null,
    state: "armed",
    expiresAt: Date.now() + PAGE_DOWNLOAD_CAPTURE_TIMEOUT_MS
  };
  pageDownloadCaptures.set(id, capture);
  setTimeout(() => {
    const current = pageDownloadCaptures.get(id);
    if (current && current.state === "armed" && Date.now() >= current.expiresAt) {
      void cancelPageDownloadCapture(id);
    }
  }, PAGE_DOWNLOAD_CAPTURE_TIMEOUT_MS + 1000);
  return {
    ok: true,
    captureId: id,
    sourceHost: source.host,
    queryKeys: source.queryKeys
  };
}

async function awaitPageDownloadCapture(message) {
  const captureId = String(message.captureId || "");
  const capture = pageDownloadCaptures.get(captureId);
  if (!capture) throw new Error("页面下载捕获不存在或已过期");

  let item = null;
  try {
    while (capture.downloadId == null && Date.now() < capture.expiresAt) {
      await wait(DOWNLOAD_POLL_MS);
    }
    if (capture.downloadId == null) {
      throw new Error(
        "页面未产生可捕获下载 host=" +
          capture.source.host +
          " keys=" +
          capture.source.queryKeys.join(",")
      );
    }
    item = await waitForNativeDownload(capture.downloadId);
    if (!item.filename) throw new Error("Chrome 下载完成但未返回本地文件路径");
    if (Number(item.fileSize) !== capture.expectedSize) {
      throw new Error(
        "Chrome 下载长度不一致 expected=" +
          capture.expectedSize +
          " actual=" +
          item.fileSize
      );
    }
    const finalHost = item.finalUrl
      ? validateDownloadUrl(item.finalUrl).host
      : capture.source.host;

    const result = await bridgeDownloadRequest(
      "/download/import",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: capture.token, source: item.filename })
      },
      "bridge 导入页面下载失败"
    );
    return {
      ...result,
      transport: "page-native",
      sourceHost: capture.source.host,
      finalHost
    };
  } finally {
    pageDownloadCaptures.delete(captureId);
    await removeNativeDownload(capture.downloadId, item && item.state);
    await removeDownloadHeaderRules(capture.headerRuleIds);
  }
}

async function bridgeDownloadRequest(path, options, label) {
  const response = await fetch(BRIDGE + path, { cache: "no-store", ...options });
  const text = await response.text();
  let result = null;
  try {
    result = JSON.parse(text);
  } catch (_) {}
  if (!response.ok || !result || !result.ok) {
    throw new Error(
      label +
        " HTTP " +
        response.status +
        " " +
        String((result && result.error) || text || "empty response").slice(0, 300)
    );
  }
  return result;
}

async function safeResponseErrorSummary(response) {
  let text = "";
  try {
    text = await response.text();
  } catch (_) {}
  try {
    const data = JSON.parse(text);
    const parts = [];
    for (const key of ["error_code", "errno"]) {
      if (Number.isSafeInteger(Number(data && data[key]))) {
        parts.push(key + "=" + Number(data[key]));
      }
    }
    const message = String((data && (data.error_msg || data.message)) || "")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 120);
    if (message) parts.push("message=" + message);
    return parts.length ? " " + parts.join(" ") : "";
  } catch (_) {
    return "";
  }
}

async function streamDownloadToBridge(candidates, token, expectedSize) {
  let response = null;
  let source = null;
  const candidateErrors = [];
  for (const candidate of candidates) {
    try {
      const attempt = await fetch(candidate.url, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "follow"
      });
      if (!attempt.ok) {
        const detail = await safeResponseErrorSummary(attempt);
        candidateErrors.push(
          candidate.host +
            " keys=" +
            candidate.queryKeys.join(",") +
            ": HTTP " +
            attempt.status +
            detail
        );
        continue;
      }
      // Reject an unexpected redirect before any response bytes reach disk.
      validateDownloadUrl(attempt.url);
      response = attempt;
      source = candidate;
      break;
    } catch (error) {
      candidateErrors.push(
        candidate.host +
          " keys=" +
          candidate.queryKeys.join(",") +
          ": " +
          String(error && (error.message || error))
      );
    }
  }
  if (!response || !source) {
    const error = new Error("全部流式 dlink 候选失败 " + candidateErrors.join(" | "));
    error.retryWithHeaders = true;
    throw error;
  }

  let offset = 0;
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      for (let start = 0; start < bytes.byteLength; start += DOWNLOAD_STREAM_CHUNK_BYTES) {
        const chunk = bytes.subarray(
          start,
          Math.min(start + DOWNLOAD_STREAM_CHUNK_BYTES, bytes.byteLength)
        );
        const written = await bridgeDownloadRequest(
          "/download/" + encodeURIComponent(token) + "?offset=" + offset,
          {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: chunk
          },
          "bridge 写入下载分块失败"
        );
        offset = Number(written.written);
      }
    }
  } else if (expectedSize !== 0) {
    throw new Error("下载响应缺少可读取的数据流");
  }

  const completed = await bridgeDownloadRequest(
    "/download/" + encodeURIComponent(token) + "/complete",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    },
    "bridge 完成下载失败"
  );
  return {
    ...completed,
    transport: "extension-stream",
    sourceHost: source.host,
    finalHost: new URL(response.url).hostname
  };
}

/**
 * Chrome 原生下载管理器携带目标主机的网页登录 Cookie。下载先进入默认
 * Downloads/baidu-pan-connector 暂存目录，再由 bridge 校验并原子安装到目标。
 */
async function nativeDownloadToBridge(message) {
  const rawCandidates = Array.isArray(message.dlinks) ? message.dlinks : [message.dlink];
  const candidates = [];
  const seen = new Set();
  for (const rawUrl of rawCandidates) {
    if (!rawUrl) continue;
    const source = validateDownloadUrl(rawUrl);
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    candidates.push(source);
  }
  const token = String(message.token || "");
  const expectedSize = Number(message.expectedSize);
  if (!token) throw new Error("download token 缺失");
  if (!candidates.length) throw new Error("download dlink 候选为空");
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error("download expectedSize 非法");
  }
  if (expectedSize > WEB_DOWNLOAD_MAX_BYTES) {
    throw new Error(
      "网页下载安全上限为 50 MiB；大文件不得由扩展反复尝试，请改用百度网盘客户端"
    );
  }

  let downloadId = null;
  let item = null;
  let source = null;
  let headerRuleIds = [];
  try {
    // The signed web-UI address normally uses Chrome's browser UA, while the
    // filemetas compatibility address can require a PCS Netdisk UA. Try both
    // profiles without changing cookies or exposing their values.
    const profileErrors = [];
    for (const profile of DOWNLOAD_HEADER_PROFILES) {
      headerRuleIds = await installDownloadHeaderRules(candidates, profile);
      const candidateErrors = [];
      item = null;
      for (const candidate of candidates) {
        source = candidate;
        downloadId = null;
        item = null;
        try {
          downloadId = await chrome.downloads.download({
            url: source.url,
            filename: "baidu-pan-connector/" + token + ".download",
            conflictAction: "overwrite",
            saveAs: false
          });
          item = await waitForNativeDownload(downloadId);
          if (!item.filename) throw new Error("Chrome 下载完成但未返回本地文件路径");
          if (Number(item.fileSize) !== expectedSize) {
            throw new Error(
              "Chrome 下载长度不一致 expected=" + expectedSize + " actual=" + item.fileSize
            );
          }
          break;
        } catch (error) {
          candidateErrors.push(
            source.host +
              " keys=" +
              source.queryKeys.join(",") +
              ": " +
              compactError(error, 240)
          );
          await removeNativeDownload(downloadId, item && item.state);
          downloadId = null;
          item = null;
        }
      }

      if (!item) {
        const nativeError = "全部原生 dlink 候选失败 " + candidateErrors.join(" | ");
        try {
          const streamed = await streamDownloadToBridge(candidates, token, expectedSize);
          return { ...streamed, headerProfile: profile.name };
        } catch (streamError) {
          const combined =
            "profile=" +
            profile.name +
            " " +
            nativeError +
            "；流式回退失败 " +
            compactError(streamError, 300);
          profileErrors.push(combined);
          if (!streamError.retryWithHeaders) throw new Error(combined);
          continue;
        }
      }

      const imported = await fetch(BRIDGE + "/download/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, source: item.filename }),
        cache: "no-store"
      });
      const text = await imported.text();
      let result = null;
      try {
        result = JSON.parse(text);
      } catch (_) {}
      if (!imported.ok || !result || !result.ok) {
        throw new Error(
          "bridge 导入下载失败 HTTP " +
            imported.status +
            " " +
            ((result && result.error) || text).slice(0, 300)
        );
      }
      await removeNativeDownload(downloadId, item.state);
      return {
        ...result,
        transport: "chrome-native",
        headerProfile: profile.name,
        sourceHost: source.host,
        finalHost: item.finalUrl ? new URL(item.finalUrl).hostname : source.host
      };
    }
    throw new Error(compactError("所有下载请求头配置均失败 " + profileErrors.join(" || ")));
  } catch (error) {
    await removeNativeDownload(downloadId, item && item.state);
    throw error;
  } finally {
    await removeDownloadHeaderRules(headerRuleIds);
  }
}

function normalizePack(pack) {
  const auto = !!(pack.auto || pack.auto_execute);
  const policy = pack.auto_policy || (auto ? { mode: "all", skip_confirm: true } : null);
  const tasks = (pack.tasks || []).map((t) => {
    let status = t.status || "pending";
    // auto 包：未终态任务若已预标 approved 则保留；否则按 policy 核准
    if (auto && status !== "done" && status !== "failed" && status !== "rejected") {
      if (status === "approved") {
        // keep
      } else if (policy && policy.mode === "safe") {
        if (t.op === "delete" || t.risk === "high") status = "pending";
        else status = "approved";
      } else {
        status = "approved";
      }
    }
    return {
      ...t,
      status,
      result: t.result || null
    };
  });
  return {
    schema: pack.schema || "baidu-pan-task-pack/v1",
    id: pack.id,
    title: pack.title || pack.id,
    description: pack.description || "",
    snapshot: pack.snapshot || "",
    auto,
    auto_execute: auto,
    auto_policy: policy,
    push_seq: pack.push_seq || Date.now(),
    receivedAt: Date.now(),
    tasks
  };
}

async function fetchJson(url, maxBytes = JSON_RESPONSE_MAX_BYTES) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  const declared = Number(r.headers.get("Content-Length") || 0);
  if (declared > maxBytes) {
    throw new Error("bridge JSON 响应超过安全上限: " + declared + " bytes");
  }
  const text = await r.text();
  if (text.length > maxBytes) {
    throw new Error("bridge JSON 响应超过安全上限: >" + maxBytes + " chars");
  }
  return JSON.parse(text);
}

async function notifyTabs(msg) {
  try {
    const tabs = await chrome.tabs.query({
      url: ["https://pan.baidu.com/*", "https://yun.baidu.com/*"]
    });
    for (const t of tabs) {
      try {
        await chrome.tabs.sendMessage(t.id, msg || { type: "packs-updated" });
      } catch (_) {}
    }
    return tabs.length;
  } catch (_) {
    return 0;
  }
}

// 写操作必须只有一个执行者。同一任务若广播到多个网盘页签，多个页签会
// 同时通过 pathExists 检查并提交创建请求，百度网盘随后会生成时间戳副本。
// 因此按页签顺序尝试投递，并在首个 content script 接受任务后立即停止。
async function notifyOneTab(msg) {
  try {
    const tabs = await chrome.tabs.query({
      url: ["https://pan.baidu.com/*", "https://yun.baidu.com/*"]
    });
    for (const t of tabs) {
      try {
        const answer = await chrome.tabs.sendMessage(t.id, msg);
        if (answer) return { delivered: 1, answer, tabId: t.id };
      } catch (_) {}
    }
    return { delivered: 0, answer: null, tabId: null };
  } catch (_) {
    return { delivered: 0, answer: null, tabId: null };
  }
}

/**
 * @param {{ force?: boolean }} opts force=true 时用桥上内容覆盖本地同 id 包
 */
let historyHydrated = false;
let pollBridgeInFlight = null;

async function pollBridgeOnce(opts = {}) {
  const force = !!opts.force;
  const result = {
    ok: false,
    bridge: BRIDGE,
    imported: [],
    skipped: [],
    autoQueued: [],
    pendingCount: 0,
    historyCount: 0,
    error: null
  };

  try {
    let health;
    try {
      health = await fetchJson(BRIDGE + "/health");
    } catch (e) {
      result.error =
        "任务桥未连接（" +
        BRIDGE +
        "）。请先运行 Skill 中的 scripts/start_connector.ps1";
      await chrome.storage.local.set({ lastPoll: { ...result, at: Date.now() } });
      return result;
    }
    result.pendingCount = health.pending || 0;
    result.historyCount = health.history || 0;

    const pendingData = await fetchJson(BRIDGE + "/pending");
    let historyData = { packs: [] };
    if (force || !historyHydrated) {
      try {
        historyData = await fetchJson(BRIDGE + "/history?limit=50");
        historyHydrated = true;
      } catch (_) {}
    }

    const byId = new Map();
    for (const p of historyData.packs || []) {
      if (p && p.id) byId.set(p.id, p);
    }
    for (const p of pendingData.packs || []) {
      if (p && p.id) byId.set(p.id, p);
    }
    if (!result.historyCount) result.historyCount = byId.size;

    const store = await chrome.storage.local.get([
      "packs",
      "activePackId",
      "dismissedPackIds"
    ]);
    const packs = store.packs || {};
    const dismissed = new Set(store.dismissedPackIds || []);
    let changed = false;
    let dismissedChanged = false;
    let activePackId = store.activePackId || null;
    const acked = [];
    const autoRunIds = [];

    for (const pack of byId.values()) {
      if (!pack.id || !pack.tasks) continue;
      if (dismissed.has(pack.id) && !force && !(pack.auto || pack.auto_execute)) {
        result.skipped.push(pack.id + "(已清空)");
        continue;
      }
      const existing = packs[pack.id];
      const incomingSeq = pack.push_seq || 0;
      const localSeq = existing && existing.push_seq;
      const isAuto = !!(pack.auto || pack.auto_execute);
      // auto 新 push_seq 或 force：覆盖导入
      const shouldImport =
        force ||
        !existing ||
        (isAuto && incomingSeq && incomingSeq !== localSeq) ||
        (!isAuto && !existing);

      if (!shouldImport) {
        result.skipped.push(pack.id);
        // 已在本地的 auto 包若仍有 approved 未跑，也触发执行
        if (
          existing &&
          existing.auto &&
          (existing.tasks || []).some((t) => t.status === "approved")
        ) {
          autoRunIds.push(pack.id);
        }
        continue;
      }
      if (force && dismissed.has(pack.id)) {
        dismissed.delete(pack.id);
        dismissedChanged = true;
      }
      if (isAuto && dismissed.has(pack.id)) {
        dismissed.delete(pack.id);
        dismissedChanged = true;
      }
      const normalized = normalizePack(pack);
      packs[pack.id] = normalized;
      result.imported.push(pack.id);
      activePackId = pack.id;
      changed = true;
      acked.push(pack.id);
      if (normalized.auto) {
        autoRunIds.push(pack.id);
        result.autoQueued.push(pack.id);
      }
    }

    if (changed || dismissedChanged) {
      await chrome.storage.local.set({
        packs,
        activePackId,
        dismissedPackIds: Array.from(dismissed)
      });
      await notifyTabs({ type: "packs-updated" });
      if (acked.length) {
        await fetch(BRIDGE + "/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: acked })
        }).catch(() => {});
      }
    }

    // 通知 content 静默执行 auto 包（connector 模式）
    for (const id of autoRunIds) {
      const delivery = await notifyOneTab({ type: "auto-run-pack", id });
      if (!delivery.delivered) {
        // 无 pan 页：记 error 到 bridge，CLI wait 能看见
        await fetch(BRIDGE + "/run/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            status: "waiting_tab",
            error: "no pan.baidu.com tab; open and keep logged in",
            counts: {}
          })
        }).catch(() => {});
      }
    }

    result.ok = true;
    if (!byId.size) {
      result.error =
        "桥已连接，但没有任务包（pending/history 皆空）。请 agent: pan_task.py push …";
    } else if (!result.imported.length && !force) {
      result.error = null;
      result.note =
        "任务包已在本地（" +
        result.skipped.join(", ") +
        "）。auto 执行由 connector 触发；面板仅作观察。";
    } else if (force && result.imported.length) {
      result.note = "强制重载已导入: " + result.imported.join(", ");
    }
  } catch (e) {
    result.error = compactError(e);
  }

  await chrome.storage.local.set({ lastPoll: { ...result, at: Date.now() } });
  return result;
}

async function pollBridge(opts = {}) {
  if (pollBridgeInFlight) {
    if (!opts.force) return pollBridgeInFlight;
    await pollBridgeInFlight.catch(() => {});
  }
  const current = pollBridgeOnce(opts);
  pollBridgeInFlight = current;
  try {
    return await current;
  } finally {
    if (pollBridgeInFlight === current) pollBridgeInFlight = null;
  }
}

setInterval(() => pollBridge(), POLL_MS);
pollBridge();

// 实况查询：bridge 排队 → pan 页 content script
const PAN_RPC_MS = 2500;
let panRpcInFlight = false;

async function sendPanRpcToAnyTab(payload) {
  const tabs = await chrome.tabs.query({
    url: ["https://pan.baidu.com/*", "https://yun.baidu.com/*"]
  });
  if (!tabs.length) {
    return { ok: false, error: "no pan.baidu.com tab open with extension" };
  }
  let lastErr = "no content script";
  for (const t of tabs) {
    try {
      const answer = await chrome.tabs.sendMessage(t.id, payload);
      if (answer) return answer;
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  return {
    ok: false,
    error: lastErr + " (reload pan page / extension)"
  };
}

async function pollPanRpc() {
  if (panRpcInFlight) return;
  panRpcInFlight = true;
  try {
    const data = await fetchJson(BRIDGE + "/pan/rpc/pending");
    const reqs = data.requests || [];
    if (!reqs.length) return;
    for (const req of reqs) {
      const answer = await sendPanRpcToAnyTab({
        type: "pan-rpc",
        id: req.id,
        op: req.op,
        params: req.params || {}
      });
      await fetch(BRIDGE + "/pan/rpc/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: req.id,
          ok: !!(answer && answer.ok),
          result: answer && answer.result,
          error: answer && answer.error
        })
      }).catch(() => {});
    }
  } catch (_) {
  } finally {
    panRpcInFlight = false;
  }
}

setInterval(() => pollPanRpc(), PAN_RPC_MS);
pollPanRpc();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "download-context-main-world") {
    getPageDownloadContextFromMainWorld(sender)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error && (error.message || error)) })
      );
    return true;
  }
  if (msg?.type === "download-page-prepare") {
    preparePageDownloadCapture(msg)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error && (error.message || error)) })
      );
    return true;
  }
  if (msg?.type === "download-page-await") {
    awaitPageDownloadCapture(msg)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error && (error.message || error)) })
      );
    return true;
  }
  if (msg?.type === "download-page-cancel") {
    cancelPageDownloadCapture(msg.captureId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error && (error.message || error)) })
      );
    return true;
  }
  if (msg?.type === "download-native") {
    nativeDownloadToBridge(msg)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error && (error.message || error)) })
      );
    return true;
  }
  if (msg?.type === "poll-now") {
    pollBridge({ force: !!msg.force }).then((r) => sendResponse(r));
    return true;
  }
  if (msg?.type === "import-pack") {
    (async () => {
      try {
        const pack = normalizePack(msg.pack);
        const { packs = {} } = await chrome.storage.local.get("packs");
        packs[pack.id] = pack;
        await chrome.storage.local.set({ packs, activePackId: pack.id });
        await notifyTabs({ type: "packs-updated" });
        if (pack.auto) {
          await notifyOneTab({ type: "auto-run-pack", id: pack.id });
        }
        sendResponse({ ok: true, id: pack.id });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
  if (msg?.type === "get-last-poll") {
    chrome.storage.local.get("lastPoll").then((d) => sendResponse(d.lastPoll || null));
    return true;
  }
  if (msg?.type === "clear-pack") {
    (async () => {
      const id = msg.id;
      const store = await chrome.storage.local.get([
        "packs",
        "activePackId",
        "dismissedPackIds"
      ]);
      const packs = store.packs || {};
      const dismissed = new Set(store.dismissedPackIds || []);
      if (id && packs[id]) {
        delete packs[id];
        dismissed.add(id);
      }
      let activePackId = store.activePackId;
      if (activePackId === id) {
        activePackId = Object.keys(packs)[0] || null;
      }
      await chrome.storage.local.set({
        packs,
        activePackId,
        dismissedPackIds: Array.from(dismissed)
      });
      await fetch(BRIDGE + "/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: id ? [id] : [] })
      }).catch(() => {});
      await notifyTabs({ type: "packs-updated" });
      sendResponse({ ok: true, activePackId });
    })();
    return true;
  }
  if (msg?.type === "clear-all-packs") {
    (async () => {
      const store = await chrome.storage.local.get(["packs", "dismissedPackIds"]);
      const packs = store.packs || {};
      const ids = Object.keys(packs);
      const dismissed = new Set(store.dismissedPackIds || []);
      for (const id of ids) dismissed.add(id);
      await chrome.storage.local.set({
        packs: {},
        activePackId: null,
        dismissedPackIds: Array.from(dismissed)
      });
      await fetch(BRIDGE + "/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, all: true })
      }).catch(() => {});
      await notifyTabs({ type: "packs-updated" });
      sendResponse({ ok: true, cleared: ids.length });
    })();
    return true;
  }
  if (msg?.type === "bridge-fetch") {
    (async () => {
      try {
        const r = await fetch(BRIDGE + msg.path, {
          method: msg.method || "GET",
          headers: msg.headers || { "Content-Type": "application/json" },
          body: msg.body != null ? msg.body : undefined,
          cache: "no-store"
        });
        const text = await r.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {}
        sendResponse({
          ok: r.ok,
          status: r.status,
          json,
          text: text.slice(0, 2000),
          error: r.ok ? null : text.slice(0, 500)
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
});
