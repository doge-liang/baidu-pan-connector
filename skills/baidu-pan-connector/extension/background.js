// 任务桥 connector：轮询 pending/history，导入 storage；auto 包自动触发 content 执行。
// CLI 主控：python scripts/baidu-pan-tools/pan_task.py push … --auto --wait

const BRIDGE = "http://127.0.0.1:27865";
const POLL_MS = 2500;

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

async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.json();
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

/**
 * @param {{ force?: boolean }} opts force=true 时用桥上内容覆盖本地同 id 包
 */
async function pollBridge(opts = {}) {
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
        "）。请先运行: python scripts/baidu-pan-tools/bridge.py";
      await chrome.storage.local.set({ lastPoll: { ...result, at: Date.now() } });
      return result;
    }
    result.pendingCount = health.pending || 0;

    const pendingData = await fetchJson(BRIDGE + "/pending");
    let historyData = { packs: [] };
    try {
      historyData = await fetchJson(BRIDGE + "/history");
    } catch (_) {}

    const byId = new Map();
    for (const p of historyData.packs || []) {
      if (p && p.id) byId.set(p.id, p);
    }
    for (const p of pendingData.packs || []) {
      if (p && p.id) byId.set(p.id, p);
    }
    result.historyCount = byId.size;

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
      const n = await notifyTabs({ type: "auto-run-pack", id });
      if (!n) {
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
    result.error = String(e.message || e);
  }

  await chrome.storage.local.set({ lastPoll: { ...result, at: Date.now() } });
  return result;
}

setInterval(() => pollBridge(), POLL_MS);
pollBridge();

// 实况查询：bridge 排队 → pan 页 content script
const PAN_RPC_MS = 1500;

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
  } catch (_) {}
}

setInterval(() => pollPanRpc(), PAN_RPC_MS);
pollPanRpc();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
          await notifyTabs({ type: "auto-run-pack", id: pack.id });
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
