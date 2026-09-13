(() => {
  if (window.__bptLoaded) return;
  window.__bptLoaded = true;

  const BRIDGE = "http://127.0.0.1:27865";
  const WEB_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
  const MAX_CONSECUTIVE_AUTO_FAILURES = 3;
  const ERROR_TEXT_MAX_CHARS = 800;
  let persistInFlight = null;
  let persistDirty = false;
  const state = {
    packs: {},
    activePackId: null,
    running: false,
    collapsed: true,
    log: [],
    connection: "connecting",
    connectionMessage: "正在连接本机 bridge",
    currentTaskId: null,
    contextInvalidated: false,
    connectorTimer: null,
    panRpcTimer: null,
    // 自身 persist 触发的 storage 变更；执行中或自写回写时禁止 loadState 冲掉内存状态
    ignoreStorageReload: false,
    crawlTimer: null,
    crawlBusy: false,
    indexBusy: false,
    // connector：正在 auto 执行的 pack id，防重入
    autoRunningId: null
  };

  function compactError(value, maxChars = ERROR_TEXT_MAX_CHARS) {
    const text = String((value && (value.message || value)) || "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 20)) + " …[diagnostic truncated]";
  }

  // —— 网盘 API（同源，依赖页面登录态）——

  function getBdstoken() {
    try {
      const t = window.locals && window.locals.get && window.locals.get("bdstoken");
      if (t) return t;
    } catch (_) {}
    try {
      const t = window.yunData && (window.yunData.MYBDSTOKEN || window.yunData.bdstoken);
      if (t) return t;
    } catch (_) {}
    const m = document.documentElement.innerHTML.match(/bdstoken["':\s]+([0-9a-f]{32})/i);
    if (m) return m[1];
    throw new Error("未能取到 bdstoken，请确认已登录网盘主页面");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 单页 limit 上限 1000；超过必须分页，否则 fileMeta 会把第 1001 个起误判为不存在
  async function listDir(dir) {
    const all = [];
    let start = 0;
    const limit = 1000;
    for (;;) {
      const u =
        "/api/list?dir=" +
        encodeURIComponent(dir) +
        "&order=name&desc=0&start=" +
        start +
        "&limit=" +
        limit +
        "&web=1&clienttype=0&app_id=250528";
      const r = await fetch(u, { credentials: "same-origin" }).then((x) => x.json());
      if (r.errno !== 0) throw new Error("list " + dir + " 失败 errno=" + r.errno);
      const batch = r.list || [];
      all.push(...batch);
      if (batch.length < limit) break;
      start += limit;
      // 保险：异常超大目录
      if (start > 500000) break;
    }
    return all;
  }

  async function pathExists(path) {
    const i = path.lastIndexOf("/");
    const parent = i <= 0 ? "/" : path.slice(0, i);
    const name = path.slice(i + 1);
    try {
      const items = await listDir(parent);
      return items.some((it) => it.server_filename === name || it.path === path);
    } catch (_) {
      return false;
    }
  }

  async function fileMeta(path) {
    const i = path.lastIndexOf("/");
    const parent = i <= 0 ? "/" : path.slice(0, i);
    const name = path.slice(i + 1);
    const items = await listDir(parent);
    return items.find((it) => it.server_filename === name || it.path === path) || null;
  }

  function pageJsonString(html, key) {
    const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(html || "").match(
      new RegExp('["\\\']' + escaped + '["\\\']\\s*:\\s*["\\\']([^"\\\']+)["\\\']', "i")
    );
    return match ? match[1] : "";
  }

  function pageJsonInteger(html, key) {
    const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(html || "").match(
      new RegExp('["\\\']' + escaped + '["\\\']\\s*:\\s*["\\\']?(\\d+)', "i")
    );
    return match ? Number(match[1]) : 0;
  }

  // Baidu's page computes the short-lived /api/download signature with an
  // RC4-compatible transform: sign2(sign3, sign1), then binary base64.
  function panSign2(key, text) {
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
      const keyByte = box[(box[i] + box[j]) % 256];
      output += String.fromCharCode(text.charCodeAt(offset) ^ keyByte);
    }
    return output;
  }

  async function mainWorldPanDownloadContext() {
    return new Promise((resolve, reject) => {
      safeRuntimeSendMessage({ type: "download-context-main-world" }, (detail, error) => {
        if (error) {
          reject(new Error(error.message || String(error)));
          return;
        }
        const timestamp = Number(detail && detail.timestamp);
        if (
          !detail ||
          !detail.ok ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(String(detail.sign || "")) ||
          !Number.isSafeInteger(timestamp) ||
          timestamp <= 0
        ) {
          reject(new Error(String(detail.error || "页面主世界签名无效")));
          return;
        }
        resolve({
          sign: String(detail.sign),
          timestamp,
          vip: Number.isFinite(Number(detail.vip)) ? Number(detail.vip) : 0,
          source: String(detail.source || "main-world")
        });
      });
    });
  }

  async function getPanDownloadContext() {
    try {
      return await mainWorldPanDownloadContext();
    } catch (_) {}
    let sign1 = "";
    let sign3 = "";
    let timestamp = 0;
    try {
      const data = window.yunData || {};
      sign1 = String(data.sign1 || data.SIGN1 || "");
      sign3 = String(data.sign3 || data.SIGN3 || "");
      timestamp = Number(data.timestamp || data.TIMESTAMP || 0);
    } catch (_) {}
    const html = document.documentElement.innerHTML;
    if (!sign1) sign1 = pageJsonString(html, "sign1");
    if (!sign3) sign3 = pageJsonString(html, "sign3");
    if (!timestamp) timestamp = pageJsonInteger(html, "timestamp");
    if (!sign1 || !sign3 || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new Error("页面缺少 download sign1/sign3/timestamp，请刷新网盘主页面");
    }
    return { sign: btoa(panSign2(sign3, sign1)), timestamp, source: "html-fallback" };
  }

  /**
   * @param {string} opera
   * @param {any[]} filelist
   * @param {{ async?: 0|1|2 }} [opts]  删除小批量默认走 async=0 同步，避免 taskquery 误判
   */
  async function filemanager(opera, filelist, opts) {
    const token = getBdstoken();
    const asyncMode = opts && opts.async != null ? opts.async : 2;
    const url =
      "/api/filemanager?opera=" +
      opera +
      "&async=" +
      asyncMode +
      "&onnest=fail&bdstoken=" +
      encodeURIComponent(token) +
      "&clienttype=0&app_id=250528&web=1";
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "filelist=" + encodeURIComponent(JSON.stringify(filelist))
    }).then((x) => x.json());
  }

  /** 解析 filemanager 响应：顶层 errno 与 info[] 分项 errno */
  function filemanagerErrors(r) {
    const bad = [];
    if (!r) return ["empty response"];
    // 12 = 部分成功，须看 info
    if (r.errno !== 0 && r.errno !== 12) {
      bad.push("errno=" + r.errno);
    }
    const info = r.info || r.list || [];
    if (Array.isArray(info)) {
      for (const it of info) {
        if (it && it.errno != null && it.errno !== 0) {
          bad.push(
            (it.path || it.server_filename || "?") + " errno=" + it.errno + (it.msg ? " " + it.msg : "")
          );
        }
      }
    }
    return bad;
  }

  async function ensureDir(path) {
    if (await pathExists(path)) return { created: false };
    const token = getBdstoken();
    const url =
      "/api/create?a=commit&bdstoken=" + token + "&clienttype=0&app_id=250528&web=1";
    const r = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "path=" + encodeURIComponent(path) + "&isdir=1&block_list=%5B%5D&"
    }).then((x) => x.json());
    // errno=-8 等可能表示已存在
    if (r.errno !== 0 && r.errno !== -8) {
      throw new Error("mkdir 失败 errno=" + r.errno + " path=" + path);
    }
    return { created: r.errno === 0, r };
  }

  // 自根向下逐级建目录（网盘 create 不保证一次建多层）
  async function ensureDirDeep(path) {
    if (!path || path === "/") return;
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += "/" + part;
      await ensureDir(cur);
    }
  }

  async function waitTask(taskid, label, timeoutMs) {
    if (!taskid) return { done: true };
    const deadline = Date.now() + (timeoutMs || 60 * 60 * 1000);
    let last = null;
    while (Date.now() < deadline) {
      let r;
      const tryUrls = [
        "/api/taskquery?taskid=" + encodeURIComponent(String(taskid)) + "&clienttype=0&app_id=250528&web=1",
        "/share/taskquery?taskid=" + encodeURIComponent(String(taskid)) + "&clienttype=0&app_id=250528&web=1"
      ];
      for (const u of tryUrls) {
        try {
          r = await fetch(u, { credentials: "same-origin" }).then((x) => x.json());
          // errno 12 = 任务进行中/查询中间态，可换端点再试
          if (r && r.errno !== 12) break;
        } catch (_) {}
      }
      last = r;
      const st = r && (r.status !== undefined ? r.status : r.task_status);
      const stNum = st === undefined || st === null ? null : Number(st);
      // 成功：1 / success / task_errno===0 且 progress 完成
      if (
        st === 1 ||
        st === "1" ||
        stNum === 1 ||
        (r && (r.status === "success" || r.status === "Success")) ||
        (r && r.task_errno === 0 && (r.progress === 100 || r.progress === "100"))
      ) {
        return { done: true, r };
      }
      // 失败：2 / failed / task_errno 非 0
      if (
        st === 2 ||
        st === "2" ||
        stNum === 2 ||
        (r && (r.status === "failed" || r.status === "Failed")) ||
        (r && r.task_errno != null && r.task_errno !== 0)
      ) {
        throw new Error("任务失败 " + label + " " + JSON.stringify(r));
      }
      // 0 / running / pending → 继续等
      await sleep(1500);
    }
    throw new Error("任务超时 " + label + (last ? " last=" + JSON.stringify(last).slice(0, 400) : ""));
  }

  /**
   * 本机上传：bridge 注册本地文件并算 MD5 分块 → 扩展 precreate / superfile2 / create。
   * task 字段：
   *   local | path_local  本机绝对路径（扩展通过 bridge 读取）
   *   file_token | token  已注册 token（可选，RPC 会预填）
   *   local_meta          bridge 预填的 md5/size（可选）
   *   dest                远端目录，如 /apps/foo
   *   path                远端完整路径（可选，优先于 dest+newname）
   *   newname             远端文件名（默认本地文件名）
   *   ondup               fail | newcopy | overwrite（默认 fail）
   */
  async function registerLocalViaBridge(localPath) {
    // bridgeFetch 走 background，返回 { ok, status, json, error }
    const r = await bridgeFetch("/localfile/register", "POST", JSON.stringify({ path: localPath }));
    if (!r || !r.ok) {
      throw new Error(
        "bridge register 失败 " +
          ((r && (r.error || (r.json && r.json.error))) || JSON.stringify(r)).slice(0, 300)
      );
    }
    const j = r.json || {};
    if (!j.token) throw new Error("bridge register: " + (j.error || JSON.stringify(j)));
    return j;
  }

  async function fetchLocalChunk(token, offset, length) {
    // 二进制分块：content script 直连 bridge（CORS *），勿走 bridgeFetch（只回 JSON/截断 text）
    const u =
      BRIDGE +
      "/localfile/" +
      encodeURIComponent(token) +
      "?offset=" +
      offset +
      "&length=" +
      length;
    const r = await fetch(u, { method: "GET", cache: "no-store" });
    if (!r.ok) {
      const t = await r.text();
      throw new Error("拉取本机分块失败 HTTP " + r.status + " " + t.slice(0, 200));
    }
    return r.arrayBuffer();
  }

  async function panPrecreate(remotePath, size, blockList, contentMd5, sliceMd5) {
    const token = getBdstoken();
    const url =
      "/api/precreate?clienttype=0&app_id=250528&web=1&bdstoken=" + encodeURIComponent(token);
    const body = new URLSearchParams();
    body.set("path", remotePath);
    body.set("size", String(size));
    body.set("isdir", "0");
    body.set("autoinit", "1");
    body.set("rtype", "1");
    body.set("block_list", JSON.stringify(blockList));
    if (contentMd5) body.set("content-md5", contentMd5);
    if (sliceMd5) body.set("slice-md5", sliceMd5);
    const r = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    }).then((x) => x.json());
    return r;
  }

  async function panUploadPart(remotePath, uploadid, partseq, buf) {
    // 保留当前已投入使用的网页端 PCS 分片上传路径；凭据随 pan 登录 Cookie。
    const query =
      "method=upload&type=tmpfile&app_id=250528&channel=00000000000000000000000000000000" +
      "&clienttype=0&web=1&uploadsign=0" +
      "&path=" +
      encodeURIComponent(remotePath) +
      "&uploadid=" +
      encodeURIComponent(uploadid) +
      "&partseq=" +
      String(partseq);
    const hosts = [
      "https://c3.pcs.baidu.com/rest/2.0/pcs/superfile2?",
      "https://c1.pcs.baidu.com/rest/2.0/pcs/superfile2?",
      "https://c2.pcs.baidu.com/rest/2.0/pcs/superfile2?",
      "https://njc-upload.pcs.baidu.com/rest/2.0/pcs/superfile2?"
    ];
    let lastError = null;
    for (const host of hosts) {
      try {
        const response = await fetch(host + query, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/octet-stream" },
          body: buf
        });
        const text = await response.text();
        let result = null;
        try {
          result = JSON.parse(text);
        } catch (_) {
          result = { raw: text.slice(0, 200), status: response.status };
        }
        if (
          response.ok &&
          result &&
          (result.md5 || result.error_code === 0 || result.errno === 0 || !result.error_code)
        ) {
          if (result.error_code && result.error_code !== 0 && result.error_code !== "0") {
            lastError = result;
            continue;
          }
          return result;
        }
        lastError = result || { status: response.status };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      "分片上传失败 partseq=" + partseq + " " + JSON.stringify(lastError).slice(0, 300)
    );
  }

  async function panCreateFile(remotePath, size, uploadid, blockList, rtype) {
    const token = getBdstoken();
    const url =
      "/api/create?a=commit&bdstoken=" +
      encodeURIComponent(token) +
      "&clienttype=0&app_id=250528&web=1";
    const body = new URLSearchParams();
    body.set("path", remotePath);
    body.set("size", String(size));
    body.set("isdir", "0");
    body.set("rtype", String(rtype != null ? rtype : 1));
    body.set("block_list", JSON.stringify(blockList));
    if (uploadid) body.set("uploadid", uploadid);
    const r = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    }).then((x) => x.json());
    return r;
  }

  function joinRemote(dest, newname) {
    const d = (dest || "/").replace(/\/+$/, "") || "";
    const n = (newname || "").replace(/^\/+/, "");
    if (!n) throw new Error("缺少远端文件名 newname");
    if (!d || d === "") return "/" + n;
    return d + "/" + n;
  }

  async function uploadOne(task) {
    let meta = task.local_meta || null;
    let fileToken = task.file_token || task.token || (meta && meta.token) || "";
    const localPath = task.local || task.path_local || task.local_path || "";

    if (!fileToken) {
      if (!localPath) throw new Error("upload 需要 local（本机绝对路径）或 file_token");
      log("注册本机文件 " + localPath);
      meta = await registerLocalViaBridge(localPath);
      fileToken = meta.token;
    } else if (!meta || !meta.block_list) {
      // 仅有 token 时再 register 一次拿 md5 不可行；用 token 拉完整 meta 需 bridge 支持
      // 若 RPC 已带 local_meta 则足够；否则用 local 再注册
      if (localPath) {
        meta = await registerLocalViaBridge(localPath);
        fileToken = meta.token;
      } else {
        throw new Error("upload 有 token 但缺 local_meta.block_list");
      }
    }

    const size = Number(meta.size);
    const blockList = meta.block_list;
    const blockSize = Number(meta.block_size) || 4 * 1024 * 1024;
    const contentMd5 = meta.content_md5;
    const sliceMd5 = meta.slice_md5;
    const newname = task.newname || meta.name;
    let remotePath = task.path;
    if (!remotePath) {
      if (!task.dest) throw new Error("upload 需要 path（完整远端路径）或 dest+newname");
      remotePath = joinRemote(task.dest, newname);
    }
    // ondup: fail → 已存在则跳过；overwrite → rtype=3；newcopy → 让 create 处理
    const ondup = (task.ondup || "fail").toLowerCase();
    if (ondup === "fail" && (await pathExists(remotePath))) {
      return { ok: true, skipped: true, reason: "远端已存在", path: remotePath };
    }
    const parent = remotePath.slice(0, remotePath.lastIndexOf("/")) || "/";
    await ensureDirDeep(parent === "" ? "/" : parent);

    log("precreate " + remotePath + " size=" + size + " blocks=" + blockList.length);
    const pre = await panPrecreate(remotePath, size, blockList, contentMd5, sliceMd5);
    // return_type 2 = 秒传完成
    const retType = pre.return_type != null ? Number(pre.return_type) : Number(pre.returntype);
    if (pre.errno === 0 && retType === 2) {
      log("秒传成功 " + remotePath);
      return { ok: true, rapid: true, path: remotePath, r: pre };
    }
    if (pre.errno !== 0 && pre.errno !== 2) {
      // errno 2 有时表示部分信息；严格失败则抛出
      if (!(pre.uploadid || pre.block_list)) {
        throw new Error("precreate 失败 " + JSON.stringify(pre).slice(0, 400));
      }
    }
    const uploadid = pre.uploadid;
    if (!uploadid && retType !== 2) {
      throw new Error("precreate 无 uploadid " + JSON.stringify(pre).slice(0, 400));
    }

    // 需要上传的分片序号：响应 block_list 为未上传序号列表；缺省上传全部分片
    let parts = [];
    if (Array.isArray(pre.block_list) && pre.block_list.length) {
      parts = pre.block_list.map((x) => Number(x));
    } else {
      for (let i = 0; i < blockList.length; i++) parts.push(i);
    }

    for (let i = 0; i < parts.length; i++) {
      const seq = parts[i];
      const offset = seq * blockSize;
      const len = Math.min(blockSize, size - offset);
      if (len <= 0) continue;
      log("上传分片 " + (i + 1) + "/" + parts.length + " seq=" + seq + " bytes=" + len);
      const buf = await fetchLocalChunk(fileToken, offset, len);
      await panUploadPart(remotePath, uploadid, seq, buf);
      await sleep(80);
    }

    const rtype = ondup === "overwrite" ? 3 : 1;
    log("create " + remotePath);
    const created = await panCreateFile(remotePath, size, uploadid, blockList, rtype);
    if (created.errno !== 0 && created.errno !== -8) {
      // -8 已存在
      throw new Error("create 失败 " + JSON.stringify(created).slice(0, 400));
    }
    if (!(await pathExists(remotePath))) {
      // 短暂延迟
      await sleep(1500);
      if (!(await pathExists(remotePath))) {
        throw new Error("create 返回成功但远端未见文件 path=" + remotePath);
      }
    }
    log("上传完成 " + remotePath);
    return {
      ok: true,
      path: remotePath,
      size,
      rapid: false,
      content_md5: contentMd5,
      pre,
      created
    };
  }

  function joinLocal(dest, name) {
    const d = String(dest || "");
    const n = String(name || "").replace(/^[\\/]+/, "");
    if (!d) throw new Error("download 需要 local（完整本机路径）或 dest（本机目录）");
    if (!n) throw new Error("download 缺少本机文件名");
    if (n === "." || n === ".." || /[\\/]/.test(n)) {
      throw new Error("download newname 必须是文件名，不能包含目录分隔符");
    }
    const trimmed = d.replace(/[\\/]+$/, "");
    const separator = /^[A-Za-z]:/.test(d) || d.includes("\\") ? "\\" : "/";
    return trimmed + separator + n;
  }

  async function panDownloadUrls(remotePath, meta) {
    const dlinks = [];
    const seen = new Set();
    function addDlink(value) {
      if (!value) return;
      const normalized = String(value).replace(/&amp;/g, "&");
      if (seen.has(normalized)) return;
      seen.add(normalized);
      dlinks.push(normalized);
    }
    const metadataDlink = meta && meta.dlink;
    const token = getBdstoken();
    const common =
      "&bdstoken=" + encodeURIComponent(token) + "&clienttype=0&app_id=250528&web=1";
    const fsid = meta && (meta.fs_id != null ? meta.fs_id : meta.fsid);
    let lastError = "下载接口未返回 dlink";

    // Prefer the same signed endpoint used by the logged-in web UI. Unlike
    // OpenAPI dlinks, this contract uses the page signature and login session.
    if (fsid != null) {
      try {
        const context = await getPanDownloadContext();
        log("下载签名上下文 " + context.source);
        const params = new URLSearchParams();
        params.set("channel", "chunlei");
        params.set("clienttype", "0");
        params.set("web", "1");
        params.set("app_id", "250528");
        params.set("bdstoken", token);
        params.set("fidlist", JSON.stringify([fsid]));
        params.set("type", "dlink");
        params.set("vip", String(context.vip || 0));
        params.set("sign", context.sign);
        params.set("timestamp", String(context.timestamp));
        const response = await fetch("/api/download?" + params.toString(), {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store"
        });
        const result = await response.json();
        if (!response.ok || Number(result.errno || 0) !== 0) {
          lastError = "网页下载签名接口失败 errno=" + String(result.errno);
        } else {
          const rawEntries = result.dlink || result.list || [];
          const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
          for (const entry of entries) addDlink(entry && (entry.dlink || entry));
        }
      } catch (error) {
        lastError = "网页下载签名接口失败 " + String(error && (error.message || error));
      }
    }

    // Metadata dlinks are compatibility candidates. Keep them behind the
    // current signed endpoint so an obsolete list result cannot delay success.
    addDlink(metadataDlink);

    const urls = [];
    if (fsid != null) {
      urls.push(
        "/api/filemetas?dlink=1&fsids=" + encodeURIComponent(JSON.stringify([fsid])) + common
      );
    }
    urls.push(
      "/api/filemetas?dlink=1&target=" + encodeURIComponent(JSON.stringify([remotePath])) + common
    );
    for (const url of urls) {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch (_) {
        lastError = "filemetas 返回非 JSON，HTTP " + response.status;
        continue;
      }
      if (!response.ok || (result.errno != null && Number(result.errno) !== 0)) {
        lastError = "获取下载地址失败 " + JSON.stringify(result).slice(0, 400);
        continue;
      }
      const entries = result.info || result.list || [];
      const first = Array.isArray(entries) ? entries[0] : entries;
      let dlink = first && first.dlink;
      if (Array.isArray(dlink)) dlink = dlink[0] && (dlink[0].dlink || dlink[0]);
      addDlink(dlink);
    }
    if (dlinks.length) return dlinks;
    throw new Error(lastError);
  }

  async function registerDownloadViaBridge(localPath, meta, ondup) {
    const md5 = /^[0-9a-f]{32}$/i.test(String(meta.md5 || "")) ? String(meta.md5) : "";
    const response = await bridgeFetch(
      "/download/register",
      "POST",
      JSON.stringify({
        local: localPath,
        size: Number(meta.size) || 0,
        md5,
        ondup: ondup || "fail"
      })
    );
    if (!response || !response.ok || !response.json || !response.json.token) {
      throw new Error(
        "download register 失败 " +
          ((response && (response.error || (response.json && response.json.error))) ||
            JSON.stringify(response)).slice(0, 300)
      );
    }
    return response.json;
  }

  function sendDownloadMessage(message, fallbackError) {
    return new Promise((resolve, reject) => {
      safeRuntimeSendMessage(message, (response, runtimeError) => {
        if (runtimeError) {
          reject(new Error(runtimeError.message || String(runtimeError)));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error((response && response.error) || fallbackError));
          return;
        }
        resolve(response);
      });
    });
  }

  function triggerPageContextDownload(dlink) {
    // A hidden subframe makes the network request as part of the logged-in Pan
    // document. A 403 response stays isolated in the frame instead of replacing
    // the user's Netdisk tab; an attachment response becomes a Chrome download.
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.src = dlink;
    (document.body || document.documentElement).appendChild(frame);
    return () => frame.remove();
  }

  async function pageContextDownloadViaBackground(dlinks, registration, meta) {
    const errors = [];
    for (const dlink of dlinks) {
      let captureId = "";
      let removeFrame = null;
      try {
        const prepared = await sendDownloadMessage(
          {
            type: "download-page-prepare",
            dlink,
            token: registration.token,
            expectedSize: Number(meta.size) || 0
          },
          "页面下载捕获准备失败"
        );
        captureId = prepared.captureId;
        removeFrame = triggerPageContextDownload(dlink);
        return await sendDownloadMessage(
          { type: "download-page-await", captureId },
          "页面下载捕获未返回结果"
        );
      } catch (error) {
        errors.push(compactError(error, 240));
      } finally {
        if (removeFrame) removeFrame();
        if (captureId) {
          try {
            await sendDownloadMessage(
              { type: "download-page-cancel", captureId },
              "取消页面下载捕获失败"
            );
          } catch (_) {}
        }
      }
    }
    throw new Error(compactError("全部页面上下文 dlink 候选失败 " + errors.join(" | ")));
  }

  async function nativeDownloadViaBackground(dlinks, registration, meta) {
    let pageError = "";
    try {
      return await pageContextDownloadViaBackground(dlinks, registration, meta);
    } catch (error) {
      pageError = compactError(error, 300);
    }
    try {
      return await sendDownloadMessage(
        {
          type: "download-native",
          dlinks,
          token: registration.token,
          expectedSize: Number(meta.size) || 0
        },
        "Chrome 原生下载未返回结果"
      );
    } catch (error) {
      throw new Error(
        "页面上下文下载失败 " +
          pageError +
          "；扩展下载回退失败 " +
          compactError(error, 300)
      );
    }
  }

  async function finishDownloadAtBridge(token, action) {
    const response = await bridgeFetch(
      "/download/" + encodeURIComponent(token) + "/" + action,
      "POST",
      "{}"
    );
    if (!response || !response.ok) {
      throw new Error(
        "download " +
          action +
          " 失败 " +
          ((response && (response.error || (response.json && response.json.error))) ||
            JSON.stringify(response)).slice(0, 300)
      );
    }
    return response.json || { ok: true };
  }

  /**
   * 网盘下载：网页登录态取得 dlink，优先由登录中的网盘文档触发附件请求，
   * 捕获到隔离暂存区后由 bridge 校验大小与 MD5，再原子安装到目标。
   */
  async function downloadOne(task) {
    const remotePath = task.path || task.remote;
    if (!remotePath || !String(remotePath).startsWith("/")) {
      throw new Error("download 需要网盘绝对路径 path");
    }
    const meta = await fileMeta(remotePath);
    if (!meta) throw new Error("远端文件不存在: " + remotePath);
    if (meta.isdir === 1 || meta.isdir === "1") {
      throw new Error("download 当前只支持单个文件，不支持目录: " + remotePath);
    }
    const remoteName = meta.server_filename || remotePath.slice(remotePath.lastIndexOf("/") + 1);
    const localPath =
      task.local || task.local_path ||
      (task.dest ? joinLocal(task.dest, task.newname || remoteName) : "");
    if (!localPath) throw new Error("download 需要 local（完整本机路径）或 dest（本机目录）");
    const ondup = String(task.ondup || "fail").toLowerCase();
    if (ondup !== "fail" && ondup !== "overwrite") {
      throw new Error("download ondup 仅支持 fail 或 overwrite");
    }
    const expectedSize = Number(meta.size) || 0;
    if (expectedSize > WEB_DOWNLOAD_MAX_BYTES) {
      throw new Error(
        "网页下载安全上限为 50 MiB；已停止扩展下载，避免网页限制触发持续重试。请改用百度网盘客户端"
      );
    }

    let registration = null;
    try {
      registration = await registerDownloadViaBridge(localPath, meta, ondup);
      const dlinks = await panDownloadUrls(remotePath, meta);
      log("下载开始 " + remotePath + " → " + registration.path + " size=" + Number(meta.size || 0));
      const completed = await nativeDownloadViaBackground(dlinks, registration, meta);
      log("下载完成 " + remotePath + " → " + completed.path);
      return {
        ok: true,
        path: remotePath,
        local: completed.path,
        size: completed.size,
        md5: completed.md5
      };
    } catch (error) {
      if (registration && registration.token) {
        try {
          await finishDownloadAtBridge(registration.token, "abort");
        } catch (_) {}
      }
      throw error;
    }
  }

  async function copyOne(item) {
    const path = item.path;
    const dest = item.dest;
    const newname = item.newname;
    const size = item.size;
    const isDir = !!item.isdir;
    // 目录整夹复制不校验 size；文件校验源
    if (!isDir && size != null) {
      const meta = await fileMeta(path);
      if (!meta) {
        // 快照过期或源已搬走：记为跳过，不抬高失败中止计数
        return { ok: true, skipped: true, reason: "源文件不存在（可能已搬走或快照过期）" };
      }
      if (Number(meta.size) !== Number(size)) {
        throw new Error("源体积不符 expect=" + size + " got=" + meta.size + " path=" + path);
      }
    } else if (isDir) {
      if (!(await pathExists(path))) {
        return { ok: true, skipped: true, reason: "源目录不存在（可能已搬走）" };
      }
    }
    const destPath = dest + "/" + newname;
    const existing = await fileMeta(destPath).catch(() => null);
    if (existing && !isDir && size != null && Number(existing.size) === Number(size)) {
      return { ok: true, skipped: true, reason: "目标已存在且体积一致" };
    }
    if (existing && isDir) {
      return { ok: true, skipped: true, reason: "目标目录名已存在，跳过以免 newcopy 分叉" };
    }
    await ensureDirDeep(dest);
    const r = await filemanager("copy", [
      { path, dest, newname, ondup: isDir ? "fail" : "newcopy" }
    ]);
    if (r.errno !== 0) throw new Error("copy errno=" + r.errno + " " + JSON.stringify(r));
    if (r.taskid) await waitTask(r.taskid, newname || path, 60 * 60 * 1000);
    return { ok: true, r };
  }

  async function runTask(task) {
    if (task.op === "mkdir") {
      const r = await ensureDirDeep(task.path);
      return { ok: true, r };
    }
    if (task.op === "upload" || task.op === "upload_file") {
      return uploadOne(task);
    }
    if (task.op === "download" || task.op === "download_file") {
      return downloadOne(task);
    }
    if (task.op === "copy") {
      return copyOne(task);
    }
    if (task.op === "copy-batch") {
      const items = task.items || [];
      if (!items.length) throw new Error("copy-batch 无 items");
      let done = 0;
      let skipped = 0;
      const failures = [];
      log("批量复制开始，共 " + items.length + " 个");
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        try {
          const r = await copyOne(it);
          if (r.skipped) skipped++;
          else done++;
          if ((i + 1) % 20 === 0 || i === items.length - 1) {
            log(
              "批量进度 " +
                (i + 1) +
                "/" +
                items.length +
                "（新复制 " +
                done +
                " / 跳过 " +
                skipped +
                " / 失败 " +
                failures.length +
                "）"
            );
          }
        } catch (e) {
          failures.push({ path: it.path, error: String(e.message || e) });
          log("批量失败 " + it.path + "：" + (e.message || e));
          // 连续失败过多则中止，避免盲跑
          if (failures.length >= 20) {
            throw new Error(
              "copy-batch 失败已达 " + failures.length + "，中止。已完成 " + (done + skipped)
            );
          }
        }
        await sleep(200);
      }
      if (failures.length) {
        return {
          ok: false,
          error:
            "完成但有 " +
            failures.length +
            " 个失败（新复制 " +
            done +
            " / 跳过 " +
            skipped +
            "）",
          failures: failures.slice(0, 50),
          done,
          skipped
        };
      }
      return { ok: true, done, skipped, total: items.length };
    }
    if (task.op === "delete") {
      if (!(await pathExists(task.path))) {
        return { ok: true, skipped: true, reason: "路径已不存在" };
      }
      // 单条/少量删除用同步 async=0：A1 收尾等文件删除在 async=2+taskquery 上易误报失败
      const paths = Array.isArray(task.filelist) && task.filelist.length
        ? task.filelist
        : [task.path];
      let r = await filemanager("delete", paths, { async: 0 });
      let bad = filemanagerErrors(r);
      // 同步失败时再试异步一次
      if (bad.length && !r.taskid) {
        log("delete 同步失败，改试 async=2：" + bad.join("; "));
        r = await filemanager("delete", paths, { async: 2 });
        bad = filemanagerErrors(r);
      }
      if (r.taskid) {
        try {
          await waitTask(r.taskid, "delete " + task.path, 10 * 60 * 1000);
        } catch (e) {
          // 任务查询失败但路径已进回收站 → 视为成功
          if (!(await pathExists(task.path))) {
            log("delete taskquery 报错但路径已消失，记成功：" + (e.message || e));
            return { ok: true, r, note: "path gone after taskquery error" };
          }
          throw e;
        }
      } else if (bad.length) {
        // 最终仍失败
        if (!(await pathExists(task.path))) {
          return { ok: true, r, note: "errno but path gone", warn: bad.join("; ") };
        }
        throw new Error("delete 失败 " + bad.join("; ") + " raw=" + JSON.stringify(r).slice(0, 500));
      }
      // 同步成功后确认
      if (await pathExists(task.path)) {
        // 偶发延迟：再等 2s
        await sleep(2000);
        if (await pathExists(task.path)) {
          throw new Error(
            "delete 接口返回成功但路径仍存在 path=" +
              task.path +
              " raw=" +
              JSON.stringify(r).slice(0, 400)
          );
        }
      }
      return { ok: true, r };
    }
    if (task.op === "rename") {
      if (!(await pathExists(task.path))) {
        return { ok: true, skipped: true, reason: "源路径不存在" };
      }
      const parent = task.path.slice(0, task.path.lastIndexOf("/"));
      const destPath = parent + "/" + task.newname;
      if (await pathExists(destPath)) {
        // 已是目标名
        if (task.path === destPath) {
          return { ok: true, skipped: true, reason: "已是目标文件名" };
        }
        return { ok: true, skipped: true, reason: "目标文件名已存在，跳过以免覆盖" };
      }
      const r = await filemanager("rename", [
        { path: task.path, newname: task.newname }
      ]);
      if (r.errno !== 0) throw new Error("rename errno=" + r.errno + " " + JSON.stringify(r));
      if (r.taskid) await waitTask(r.taskid, "rename " + task.newname, 10 * 60 * 1000);
      return { ok: true, r };
    }
    if (task.op === "move") {
      if (!(await pathExists(task.path))) {
        return { ok: true, skipped: true, reason: "源不存在" };
      }
      const newname = task.newname || task.path.slice(task.path.lastIndexOf("/") + 1);
      const destPath = task.dest + "/" + newname;
      if (await pathExists(destPath)) {
        return { ok: true, skipped: true, reason: "目标已存在" };
      }
      await ensureDirDeep(task.dest);
      const r = await filemanager("move", [
        {
          path: task.path,
          dest: task.dest,
          newname: newname,
          ondup: "fail"
        }
      ]);
      if (r.errno !== 0) throw new Error("move errno=" + r.errno + " " + JSON.stringify(r));
      if (r.taskid) await waitTask(r.taskid, "move " + newname, 30 * 60 * 1000);
      return { ok: true, r };
    }
    // 实况列举目录，按规则规范化文件名（只改仍脏的）
    if (task.op === "normalize-dir") {
      const dir = task.path;
      if (!(await pathExists(dir))) {
        throw new Error("目录不存在: " + dir);
      }
      const items = await listDir(dir);
      const files = items.filter((it) => !(it.isdir === 1 || it.isdir === "1"));
      const dry = !!task.dry_run;
      let renamed = 0;
      let already = 0;
      let skipped = 0;
      const plan = [];
      for (const f of files) {
        const oldName = f.server_filename;
        const newName = normalizeFilename(oldName, task.rule || "modern-math-foundations");
        if (!newName) {
          skipped++;
          log("规范跳过（无规则） " + oldName);
          plan.push({ oldName, newName: null, action: "skip-no-rule" });
          continue;
        }
        if (newName === oldName) {
          already++;
          plan.push({ oldName, newName, action: "already-ok" });
          continue;
        }
        plan.push({ oldName, newName, action: dry ? "would-rename" : "rename" });
        if (dry) {
          log("将重命名: " + oldName + " → " + newName);
          continue;
        }
        const destPath = dir + "/" + newName;
        if (await pathExists(destPath)) {
          log("目标已存在，跳过: " + newName + "（源 " + oldName + "）");
          skipped++;
          continue;
        }
        const r = await filemanager("rename", [{ path: f.path || dir + "/" + oldName, newname: newName }]);
        if (r.errno !== 0) throw new Error("rename errno=" + r.errno + " " + oldName);
        if (r.taskid) await waitTask(r.taskid, newName, 10 * 60 * 1000);
        renamed++;
        log("已重命名: " + newName);
        await sleep(200);
      }
      log(
        "normalize-dir 完成: 已规范 " +
          already +
          " / 本轮改名 " +
          renamed +
          " / 跳过 " +
          skipped +
          " / 共 " +
          files.length +
          (dry ? "（dry-run）" : "")
      );
      return { ok: true, already, renamed, skipped, total: files.length, dry, plan };
    }
    throw new Error("未知 op: " + task.op);
  }

  /** 丛书文件名规范化；优先精确表，脏名再清洗，已干净则保持 */
  function normalizeFilename(name, rule) {
    if (rule !== "modern-math-foundations") return null;
    if (!/\.pdf$/i.test(name)) return name;
    const mapped = modernMathNameMap(name);
    if (mapped) return mapped;

    const dirty =
      /z-library|1lib\.sk|·数学丛书|数学丛书\.-|^\s*\[现代数学基础丛书/i.test(name);
    if (!dirty) return name;

    let s = name.replace(/\.pdf$/i, "");
    s = s.replace(/\s*\(z-library\.sk,\s*1lib\.sk,\s*z-lib\.sk\)\s*/gi, "");
    s = s.replace(/\s*\(z-library[^)]*\)\s*/gi, "");
    s = s.replace(/^·?数学丛书\.-?\.\s*/i, "");
    s = s.replace(/^现代数学基础丛书典藏版\s*第?\d+辑\s*/g, "");
    s = s.replace(/^现代数学基础丛书\s*/g, "");
    s = s.replace(/^[\[［]现代数学基础丛书[^\]]*\]］?\s*/g, "");

    let title = s;
    let auth = "";
    const br = s.match(/^[.\s]*[\[［]([^\]］]+)[\]］]\s*(.*)$/);
    if (br) {
      title = br[1].trim();
      const rest = (br[2] || "").trim();
      const am = rest.match(/[（(]([^）)]+)[）)]/);
      if (am) auth = am[1];
    } else {
      const am = s.match(/[（(]([^）)]{1,40})[）)]/);
      if (am && !/第\d+版|典藏|上册|下册|现代数学|z-library/i.test(am[1])) {
        auth = am[1];
        title = s.replace(am[0], "").trim();
      }
    }
    auth = auth
      .replace(/编著|等著|著|编/g, "")
      .replace(/,/g, "、")
      .replace(/\s+/g, "")
      .replace(/陆钟方/g, "陆钟万")
      .trim();
    title = title.replace(/^[.\s]+|[.\s]+$/g, "").replace(/陆钟方/g, "陆钟万").trim();
    if (!title) return name;
    let out = auth ? title + "-" + auth : title;
    out = out.replace(/[\\/:*?"<>|]/g, "_");
    if (!out.toLowerCase().endsWith(".pdf")) out += ".pdf";
    return out;
  }

  /** 已知旧名 → 规范名（优先精确匹配） */
  function modernMathNameMap(name) {
    const table = {
      "[现代数学基础丛书 166]交换代数与同调代数(第2版) (李克正) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "交换代数与同调代数（第2版）-李克正.pdf",
      "·数学丛书.-.[现代数学基础丛书].[二阶椭圆型方程与椭圆型方程组]..pdf":
        "二阶椭圆型方程与椭圆型方程组.pdf",
      "·数学丛书.-.[现代数学基础丛书].[代数体函数与常微分方程]..pdf":
        "代数体函数与常微分方程.pdf",
      "·数学丛书.-.[现代数学基础丛书].[值分布].（杨乐）.pdf": "值分布-杨乐.pdf",
      "·数学丛书.-.[现代数学基础丛书].[公理集合论导引]..pdf": "公理集合论导引.pdf",
      "·数学丛书.-.[现代数学基础丛书].[半群的S-系理论]..pdf": "半群的S-系理论.pdf",
      "·数学丛书.-.[现代数学基础丛书].[整函数].pdf": "整函数.pdf",
      "·数学丛书.-.[现代数学基础丛书].[整函数和亚纯函数].（张广厚）.pdf":
        "整函数和亚纯函数-张广厚.pdf",
      "·数学丛书.-.[现代数学基础丛书].[算子代数].（李炳仁）..pdf": "算子代数-李炳仁.pdf",
      "·数学丛书.-.[现代数学基础丛书].[辛几何引论]..pdf": "辛几何引论.pdf",
      "·数学丛书.-.[现代数学基础丛书].[递归函数论].（莫绍揆）..pdf": "递归函数论-莫绍揆.pdf",
      "数学丛书.-. 现代数学基础丛书 . 递归函数论 (莫绍揆编著) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "递归函数论-莫绍揆-另一来源.pdf",
      "·数学丛书.-.[现代数学基础丛书].[非线性代数方程组与定理机器证明].（吴文俊）..pdf":
        "非线性代数方程组与定理机器证明-吴文俊.pdf",
      "·数学丛书.-.[现代数学基础丛书].[非线性演化方程].（张大潜）..pdf":
        "非线性演化方程-张大潜.pdf",
      "数理逻辑基础 (胡世华 陆钟方) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "数理逻辑基础-胡世华-陆钟万.pdf",
      "现代数学基础丛书001-数理逻辑基础(上册)-胡世华＆陆钟万-科学出版社-1981.pdf":
        "数理逻辑基础（上册）-胡世华-陆钟万.pdf",
      "概率论基础 第二版 (严士健, 王隽骧, 刘秀芳) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "概率论基础（第2版）-严士健-王隽骧-刘秀芳.pdf",
      "测度论基础(现代数学基础丛书10) (朱成熹) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "测度论基础-朱成熹.pdf",
      "现代数学基础丛书 拓扑动力系统概论 (叶向东, 黄文, 邵松 著, 刘绍学, 定光桂, 严加安, 黎景辉, 苏维宜) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "拓扑动力系统概论-叶向东-黄文-邵松.pdf",
      "现代数学基础丛书 环与代数 第2版 典藏版 (刘绍学等著；杨乐主编；姜伯驹等副主编) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "环与代数（第2版·典藏版）-刘绍学.pdf",
      "现代数学基础丛书 线性偏微分算子引论 上 (齐民友编著) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "线性偏微分算子引论（上册）-齐民友.pdf",
      "线性偏微分算子引论 上 (齐民友编著) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "线性偏微分算子引论（上册）-齐民友-另一扫描.pdf",
      "线性偏微分算子引论（下） (齐民友，徐超江编著, 齐民友, 徐超江编著, 齐民友, 徐超江) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "线性偏微分算子引论（下册）-齐民友-徐超江.pdf",
      "现代数学基础丛书典藏版 第3辑 反应扩散方程引论 (叶其孝) (z-library.sk, 1lib.sk, z-lib.sk).pdf":
        "反应扩散方程引论-叶其孝.pdf"
    };
    if (table[name]) return table[name];
    // 已是目标名之一
    const targets = new Set(Object.values(table));
    if (targets.has(name)) return name;
    // 模糊：去 z-lib 后查表键的简化
    const stripped = name.replace(/\s*\(z-library\.sk,\s*1lib\.sk,\s*z-lib\.sk\)\s*/gi, "");
    if (table[stripped]) return table[stripped];
    if (targets.has(stripped)) return stripped.endsWith(".pdf") ? stripped : stripped;
    return null; // 交给通用逻辑
  }

  // —— UI ——

  function log(msg) {
    const line =
      "[" + new Date().toLocaleTimeString() + "] " + compactError(msg, ERROR_TEXT_MAX_CHARS);
    state.log.push(line);
    if (state.log.length > 200) state.log.shift();
    const el = document.getElementById("bpt-log");
    if (el) {
      el.textContent = state.log.join("\n");
      // 日志自身滚到底；不动任务列表滚动条
      el.scrollTop = el.scrollHeight;
    }
  }

  function isContextInvalidatedError(error) {
    return /Extension context invalidated/i.test(String(error && (error.message || error)));
  }

  function readRuntimeError() {
    try {
      const error = chrome.runtime.lastError;
      return error ? { message: error.message || String(error) } : null;
    } catch (error) {
      return { message: String(error && (error.message || error)) };
    }
  }

  function stopForInvalidatedContext(error) {
    if (state.contextInvalidated) return;
    state.contextInvalidated = true;
    if (state.connectorTimer) clearInterval(state.connectorTimer);
    if (state.panRpcTimer) clearInterval(state.panRpcTimer);
    if (state.crawlTimer) clearInterval(state.crawlTimer);
    state.connectorTimer = null;
    state.panRpcTimer = null;
    state.crawlTimer = null;
    state.connection = "error";
    state.connectionMessage = "扩展已重载，请刷新百度网盘页面";
    log(state.connectionMessage);
    if (error && !isContextInvalidatedError(error)) log(String(error.message || error));
    render();
  }

  function safeRuntimeSendMessage(message, callback) {
    if (state.contextInvalidated) {
      callback(undefined, { message: state.connectionMessage });
      return;
    }
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        throw new Error("Extension context invalidated.");
      }
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = readRuntimeError();
        if (isContextInvalidatedError(runtimeError)) stopForInvalidatedContext(runtimeError);
        callback(response, runtimeError);
      });
    } catch (error) {
      if (isContextInvalidatedError(error)) stopForInvalidatedContext(error);
      callback(undefined, { message: String(error && (error.message || error)) });
    }
  }

  function activePack() {
    return state.packs[state.activePackId] || null;
  }

  function persist() {
    persistDirty = true;
    state.ignoreStorageReload = true;
    if (persistInFlight) return persistInFlight;
    let current = null;
    current = (async () => {
      try {
        // Coalesce bursts of status changes into at most one follow-up write.
        // This avoids multiple concurrent full-pack serializations in Chrome.
        do {
          persistDirty = false;
          await chrome.storage.local.set({
            packs: state.packs,
            activePackId: state.activePackId
          });
        } while (persistDirty && !state.contextInvalidated);
      } catch (error) {
        if (isContextInvalidatedError(error)) {
          stopForInvalidatedContext(error);
          return false;
        }
        log("状态持久化失败: " + compactError(error));
        return false;
      } finally {
        if (persistInFlight === current) persistInFlight = null;
        // 执行中保持屏蔽，避免 onChanged 用旧快照冲掉 done
        if (!state.running) {
          setTimeout(() => {
            if (!state.running && !persistInFlight) state.ignoreStorageReload = false;
          }, 100);
        }
      }
      return true;
    })();
    persistInFlight = current;
    return current;
  }

  async function loadState() {
    try {
      const data = await chrome.storage.local.get(["packs", "activePackId"]);
      state.packs = data.packs || {};
      state.activePackId = data.activePackId || Object.keys(state.packs)[0] || null;
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        stopForInvalidatedContext(error);
        return;
      }
      throw error;
    }
  }

  function setTaskStatus(taskId, status, result) {
    const pack = activePack();
    if (!pack) return;
    const t = pack.tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.status = status;
    if (result !== undefined) {
      t.result = result && typeof result === "object" ? { ...result } : result;
      if (t.result && t.result.error) t.result.error = compactError(t.result.error);
      if (t.result && t.result.reason) t.result.reason = compactError(t.result.reason, 400);
    }
    persist();
    render();
  }

  function countPackStatuses(pack) {
    const counts = {
      pending: 0,
      approved: 0,
      done: 0,
      failed: 0,
      rejected: 0,
      other: 0
    };
    for (const t of (pack && pack.tasks) || []) {
      const st = t.status || "pending";
      if (counts[st] != null) counts[st]++;
      else counts.other++;
    }
    return counts;
  }

  function rejectRemainingQueue(queue, startIndex, reason) {
    let rejected = 0;
    for (let index = startIndex; index < queue.length; index++) {
      const task = queue[index];
      if (task.status !== "approved") continue;
      setTaskStatus(task.id, "rejected", {
        skipped: true,
        error: compactError(reason),
        reason: "自动批次已熔断，未再发起网络或磁盘操作"
      });
      rejected++;
    }
    return rejected;
  }

  function reportRunToBridge(pack, status, extra) {
    if (!pack || !pack.id) return Promise.resolve();
    const tasks = (pack.tasks || []).map((t) => ({
      id: t.id,
      op: t.op,
      path: t.path,
      status: t.status,
      error: t.result && compactError(t.result.error),
      skipped: !!(t.result && t.result.skipped),
      reason: t.result && compactError(t.result.reason, 400),
      result: t.result || null
    }));
    const body = JSON.stringify({
      id: pack.id,
      status,
      counts: countPackStatuses(pack),
      tasks,
      push_seq: pack.push_seq,
      log_tail: state.log.slice(-20),
      ...(extra || {}),
      error: extra && compactError(extra.error)
    });
    return bridgeFetch("/run/result", "POST", body).then((resp) => {
      if (!resp.ok) log("回写 /run/result 失败: " + (resp.error || ""));
      return resp;
    });
  }

  /**
   * @param {{ auto?: boolean, packId?: string, skipConfirm?: boolean }} [opts]
   * auto/skipConfirm：connector 模式，不弹 confirm
   */
  async function executeApproved(opts) {
    opts = opts || {};
    const auto = !!(opts.auto || opts.skipConfirm);
    let pack = activePack();
    if (opts.packId) {
      pack = state.packs[opts.packId] || pack;
      if (pack) state.activePackId = pack.id;
    }
    if (!pack) {
      log("无任务包可执行");
      return { ok: false, error: "no pack" };
    }
    if (state.running) {
      log("已有执行在进行");
      return { ok: false, error: "busy" };
    }
    const queue = pack.tasks.filter((t) => t.status === "approved");
    if (!queue.length) {
      log("没有已核准的任务");
      if (auto) {
        await reportRunToBridge(pack, "done", { error: null, note: "no approved tasks" });
      }
      return { ok: true, skipped: true, reason: "no approved tasks" };
    }
    const high = queue.filter((t) => t.risk === "high" || t.op === "delete");
    if (!auto) {
      log("已拒绝网页端手动执行；请由 Agent/CLI 下发授权任务");
      return { ok: false, error: "manual execution disabled; use Agent/CLI auto authorization" };
    }
    if (auto && high.length) {
      log("connector 自动执行含 " + high.length + " 个删除/高风险任务（CLI --auto 已授权）");
    }
    state.running = true;
    state.ignoreStorageReload = true;
    if (auto) state.autoRunningId = pack.id;
    render();
    log(
      (auto ? "[auto] " : "") + "开始执行 " + queue.length + " 个已核准任务 · " + pack.id
    );
    await reportRunToBridge(pack, "running");
    const completedThisRun = new Set(
      pack.tasks.filter((x) => x.status === "done").map((x) => x.id)
    );
    let processedThisRun = 0;
    let consecutiveFailures = 0;
    let circuitReason = "";
    try {
      getBdstoken();
    } catch (e) {
      log("错误: " + e.message);
      state.running = false;
      state.ignoreStorageReload = false;
      state.autoRunningId = null;
      state.currentTaskId = null;
      await reportRunToBridge(pack, "failed", { error: String(e.message || e) });
      render();
      return { ok: false, error: String(e.message || e) };
    }
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
      const t = queue[queueIndex];
      const livePack = state.packs[pack.id] || pack;
      if (t.requires && t.requires.length) {
        const missing = [];
        for (const id of t.requires) {
          if (completedThisRun.has(id)) continue;
          const dep = livePack.tasks.find((x) => x.id === id);
          if (!dep) continue;
          if (dep.status === "done") continue;
          if (dep.result && dep.result.skipped) continue;
          missing.push(id + "(" + (dep.status || "?") + ")");
        }
        if (missing.length) {
          log("跳过 " + t.id + "：依赖未完成 " + missing.join(", "));
          setTaskStatus(t.id, "failed", { error: "依赖未完成: " + missing.join(", ") });
          processedThisRun++;
          consecutiveFailures++;
          if (auto && consecutiveFailures >= MAX_CONSECUTIVE_AUTO_FAILURES) {
            circuitReason =
              "连续 " + consecutiveFailures + " 个任务失败，自动批次已触发安全熔断";
            rejectRemainingQueue(queue, queueIndex + 1, circuitReason);
            log(circuitReason);
            break;
          }
          continue;
        }
      }
      state.currentTaskId = t.id;
      render();
      log("执行 " + t.op + " · " + (t.title || t.id));
      try {
        const r = await runTask(t);
        if (r && r.ok === false) {
          setTaskStatus(t.id, "failed", r);
          log("失败 " + t.id + "：" + (r.error || "ok=false"));
          consecutiveFailures++;
          const critical = t.risk === "high" || t.op === "delete" || t.op === "copy-batch";
          if (critical || (auto && consecutiveFailures >= MAX_CONSECUTIVE_AUTO_FAILURES)) {
            circuitReason = critical
              ? "关键步骤失败，自动批次已中止"
              : "连续 " + consecutiveFailures + " 个任务失败，自动批次已触发安全熔断";
            rejectRemainingQueue(queue, queueIndex + 1, circuitReason);
            log(circuitReason);
            break;
          }
        } else {
          consecutiveFailures = 0;
          completedThisRun.add(t.id);
          setTaskStatus(t.id, "done", r);
          log(
            "完成 " +
              t.id +
              (r && r.skipped ? "（跳过：" + r.reason + "）" : "") +
              (r && r.done != null ? " 新复制=" + r.done + " 跳过=" + r.skipped : "")
          );
        }
      } catch (e) {
        const taskError = compactError(e);
        setTaskStatus(t.id, "failed", { error: taskError });
        log("失败 " + t.id + "：" + taskError);
        consecutiveFailures++;
        const critical = t.risk === "high" || t.op === "delete" || t.op === "copy-batch";
        if (critical || (auto && consecutiveFailures >= MAX_CONSECUTIVE_AUTO_FAILURES)) {
          circuitReason = critical
            ? "关键步骤失败，自动批次已中止"
            : "连续 " + consecutiveFailures + " 个任务失败，自动批次已触发安全熔断";
          rejectRemainingQueue(queue, queueIndex + 1, circuitReason);
          log(circuitReason);
          break;
        }
      }
      processedThisRun++;
      // auto 模式每隔几步回写进度
      if (auto && processedThisRun % 3 === 0) {
        await persist();
        await reportRunToBridge(state.packs[pack.id] || pack, "running");
      }
      await sleep(auto ? 250 : 400);
    }
    state.running = false;
    state.ignoreStorageReload = false;
    state.autoRunningId = null;
    state.currentTaskId = null;
    const finalPack = state.packs[pack.id] || pack;
    await persist();
    const counts = countPackStatuses(finalPack);
    let finalStatus = "done";
    if (counts.failed > 0 && counts.done === 0) finalStatus = "failed";
    else if (counts.failed > 0) finalStatus = "partial";
    else if (counts.approved > 0) finalStatus = "partial";
    log(
      (auto ? "[auto] " : "") +
        "本轮执行结束 · " +
        finalStatus +
        " done=" +
        counts.done +
        " failed=" +
        counts.failed
    );
    await reportRunToBridge(finalPack, finalStatus, circuitReason ? { error: circuitReason } : null);
    render();
    return { ok: counts.failed === 0 && counts.rejected === 0, status: finalStatus, counts };
  }

  async function handleAutoRunPack(packId) {
    if (!packId) return { ok: false, error: "no id" };
    if (state.running) {
      if (state.autoRunningId === packId) return { ok: true, note: "already running" };
      log("[auto] 忙，稍后重试 " + packId);
      return { ok: false, error: "busy" };
    }
    await loadState();
    const pack = state.packs[packId];
    if (!pack) {
      log("[auto] 本地无包 " + packId);
      return { ok: false, error: "pack not in storage" };
    }
    state.activePackId = packId;
    // 若 push 已预标 approved，直接跑；否则按 auto 再核准
    if (pack.auto || pack.auto_execute) {
      const mode = (pack.auto_policy && pack.auto_policy.mode) || "all";
      for (const t of pack.tasks) {
        if (t.status === "done" || t.status === "failed" || t.status === "rejected") continue;
        if (t.status === "approved") continue;
        if (mode === "safe" && (t.op === "delete" || t.risk === "high")) {
          t.status = "pending";
          t.needs_human = true;
        } else {
          t.status = "approved";
        }
      }
      await persist();
    }
    const approved = pack.tasks.filter((t) => t.status === "approved").length;
    if (!approved) {
      log("[auto] 无 approved 任务（可能需人工） " + packId);
      await reportRunToBridge(pack, "needs_human", {
        error: "no auto-approved tasks; human review required"
      });
      render();
      return { ok: true, needs_human: true };
    }
    return executeApproved({ auto: true, packId, skipConfirm: true });
  }

  function getConnectorView() {
    const pack = activePack();
    const tasks = (pack && pack.tasks) || [];
    const counts = countPackStatuses(pack);
    const currentTask = tasks.find((task) => task.id === state.currentTaskId) || null;
    const failedTask = tasks.find((task) => task.status === "failed") || null;
    const waiting = counts.pending + counts.approved + counts.rejected + counts.other;
    const processed = counts.done + counts.failed + counts.rejected;

    let color = "green";
    let label = "已连接";
    let title = pack ? pack.title || pack.id : "等待 Agent 下发任务";
    let summary = state.connectionMessage || "Connector 已就绪";

    if (state.connection === "error") {
      color = "red";
      label = "连接异常";
      summary = state.connectionMessage || "无法连接本机 bridge";
    } else if (state.running) {
      color = "blue";
      label = "执行中";
      title = currentTask ? currentTask.title || currentTask.id : title;
      summary = tasks.length ? `进度 ${Math.min(processed + 1, tasks.length)}/${tasks.length}` : "正在执行 Agent 任务";
    } else if (state.crawlBusy) {
      color = "blue";
      label = "同步中";
      title = "正在读取网盘索引";
      summary = "全盘抓取由 Agent 管理";
    } else if (state.indexBusy) {
      color = "blue";
      label = "同步中";
      title = "正在重建本地索引";
      summary = "索引任务由 Agent 管理";
    } else if (counts.failed > 0) {
      color = "red";
      label = "任务失败";
      title = failedTask ? failedTask.title || failedTask.id : title;
      summary = `完成 ${counts.done} · 失败 ${counts.failed}`;
    } else if (waiting > 0) {
      color = "blue";
      label = "等待 Agent";
      summary = `待处理 ${waiting} · 已完成 ${counts.done}`;
    } else if (pack && tasks.length) {
      color = "green";
      label = "已完成";
      summary = `已完成 ${counts.done}/${tasks.length}`;
    } else if (state.connection === "connecting") {
      color = "blue";
      label = "连接中";
    }

    return {
      color,
      label,
      title,
      summary,
      packId: pack && pack.id,
      currentTaskId: state.currentTaskId,
      counts,
      running: state.running,
      log: state.log.slice(-200)
    };
  }

  function render() {
    const root = document.getElementById("bpt-root");
    if (!root) return;
    const view = getConnectorView();
    root.classList.toggle("bpt-collapsed", state.collapsed);
    root.dataset.state = view.color;

    if (state.collapsed) {
      root.innerHTML = `
        <div class="bpt-header bpt-header-compact">
          <span class="bpt-light bpt-light-${view.color}" aria-hidden="true"></span>
          <div class="bpt-compact-copy" aria-live="polite">
            <div class="bpt-current-title">${escapeHtml(view.title)}</div>
            <div class="bpt-current-summary">${escapeHtml(view.label + " · " + view.summary)}</div>
          </div>
          <button type="button" class="bpt-toggle" id="bpt-expand" aria-label="展开 Connector 状态">
            <svg class="bpt-toggle-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m6 9 6 6 6-6"></path>
            </svg>
          </button>
        </div>`;
      root.querySelector("#bpt-expand").onclick = () => {
        state.collapsed = false;
        render();
      };
      return;
    }

    root.innerHTML = `
      <div class="bpt-header">
        <div class="bpt-brand">
          <span class="bpt-light bpt-light-${view.color}" aria-hidden="true"></span>
          <span>Connector</span>
        </div>
        <span class="bpt-state-label">${escapeHtml(view.label)}</span>
        <button type="button" class="bpt-toggle" id="bpt-collapse" aria-label="收起 Connector 状态">
          <svg class="bpt-toggle-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m18 15-6-6-6 6"></path>
          </svg>
        </button>
      </div>
      <div class="bpt-status-card" aria-live="polite">
        <div class="bpt-status-eyebrow">当前任务</div>
        <div class="bpt-current-title">${escapeHtml(view.title)}</div>
        <div class="bpt-current-summary">${escapeHtml(view.summary)}</div>
        <div class="bpt-agent-note">任务控制与审批由 Agent 侧统一处理</div>
      </div>
      <div class="bpt-debug">
        <div class="bpt-debug-title"><span>DEBUG</span><span>${view.log.length} lines</span></div>
        <pre class="bpt-log" id="bpt-log">${escapeHtml(view.log.join("\n") || "等待 Connector 日志…")}</pre>
      </div>`;

    const logEl = document.getElementById("bpt-log");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    root.querySelector("#bpt-collapse").onclick = () => {
      state.collapsed = true;
      render();
    };
  }

  function logCrawlStatus(forceLog) {
    if (!window.BptCrawl) {
      log("抓取模块未加载（需扩展 0.2.0+ 并重新加载）");
      return null;
    }
    const s = window.BptCrawl.status();
    const line =
      "抓取 done=" +
      s.done +
      " queue=" +
      s.queue +
      " entries=" +
      s.entries +
      " files=" +
      s.files +
      " md5Missing=" +
      s.md5Missing +
      " rateHits=" +
      s.rateHits +
      " err=" +
      s.errors +
      (s.running ? " [运行中]" : "") +
      (s.finished ? " [完成]" : "") +
      (s.aborted ? " [已中止]" : "");
    if (forceLog || s.running) log(line);
    if (s.md5Missing > 0 && s.running && s.files > 100 && s.md5Missing / s.files > 0.05) {
      log("警告：md5Missing 偏高，去重判据可能退化，建议中止排查");
    }
    return s;
  }

  /**
   * @param {{ silent?: boolean, autoIndex?: boolean, concurrency?: number }} [opts]
   * silent=true：跳过 confirm（供 bridge pan-rpc 远程启动）
   * autoIndex=true：抓取成功后由 Agent 流程自动同步索引
   * @returns {{ ok: boolean, error?: string, started?: boolean }}
   */
  function startCrawl(opts) {
    opts = opts || {};
    if (!window.BptCrawl) {
      log("抓取模块未加载");
      return { ok: false, error: "BptCrawl not loaded" };
    }
    if (state.crawlBusy || state.running) {
      log("有任务正在执行，稍后再抓取");
      return { ok: false, error: "busy: task or crawl running" };
    }
    if (window.BptCrawl.status().running) {
      return { ok: false, error: "crawl already running" };
    }
    if (!opts.silent) {
      return { ok: false, error: "manual crawl disabled; use Agent RPC" };
    }
    const concurrency = Number(opts.concurrency) || 10;
    const autoIndex = !!opts.autoIndex;
    state.crawlBusy = true;
    render();
    log(
      "全盘抓取开始（并发 " +
        concurrency +
        (opts.silent ? "，远程触发" : "") +
        (autoIndex ? "，完成后自动同步索引" : "") +
        "）…"
    );
    if (state.crawlTimer) clearInterval(state.crawlTimer);
    state.crawlTimer = setInterval(() => logCrawlStatus(false), 5000);
    window.BptCrawl.start(concurrency)
      .then(async (s) => {
        if (state.crawlTimer) {
          clearInterval(state.crawlTimer);
          state.crawlTimer = null;
        }
        state.crawlBusy = false;
        logCrawlStatus(true);
        if (s.aborted) log("抓取已中止");
        else if (s.md5Missing) log("抓取完成，但 md5Missing=" + s.md5Missing + "，请谨慎用于去重");
        else log("抓取完成，结果等待 Agent 侧后续处理");
        if (autoIndex && s.finished && !s.aborted) {
          log("Agent 任务：自动同步本地索引…");
          await uploadAndRebuildIndex({ silent: true });
        }
        render();
      })
      .catch((e) => {
        if (state.crawlTimer) {
          clearInterval(state.crawlTimer);
          state.crawlTimer = null;
        }
        state.crawlBusy = false;
        log("抓取失败: " + (e.message || e));
        render();
      });
    return { ok: true, started: true };
  }

  function stopCrawl() {
    if (!window.BptCrawl) return;
    window.BptCrawl.abort();
    log("Agent 已请求停止抓取；当前目录列举结束后终止");
  }

  /**
   * @param {{ silent?: boolean }} [opts]
   * @returns {Promise<{ ok: boolean, error?: string, upload?: object, rebuild?: object }>}
   */
  async function uploadAndRebuildIndex(opts) {
    opts = opts || {};
    if (!window.BptCrawl) {
      log("抓取模块未加载");
      return { ok: false, error: "BptCrawl not loaded" };
    }
    const s = window.BptCrawl.status();
    if (!s.finished && !s.entries) {
      log("请先完成抓取");
      return { ok: false, error: "no crawl data; finish crawl first" };
    }
    if (s.running) {
      log("抓取仍在进行");
      return { ok: false, error: "crawl still running" };
    }
    if (!s.entries) {
      log("无数据可上传");
      return { ok: false, error: "no entries" };
    }
    if (!opts.silent) {
      return { ok: false, error: "manual index rebuild disabled; use Agent RPC" };
    }
    if (s.md5Missing) {
      log("警告：md5Missing=" + s.md5Missing + "，远程静默模式仍继续重建");
    }
    state.indexBusy = true;
    render();
    try {
      log("构建 payload… entries=" + s.entries);
      const payload = window.BptCrawl.buildPayload();
      const body = JSON.stringify(payload);
      log("上传 bridge /crawl/upload（约 " + (body.length / 1048576).toFixed(1) + " MB）…");
      const upResp = await bridgeFetch("/crawl/upload", "POST", body);
      if (!upResp.ok) {
        const err = upResp.error || JSON.stringify(upResp.json || upResp);
        log("上传失败: " + err);
        return { ok: false, error: "upload failed: " + err };
      }
      const up = upResp.json || {};
      if (!up.ok) {
        const err = up.error || JSON.stringify(up);
        log("上传失败: " + err);
        return { ok: false, error: "upload failed: " + err };
      }
      log("已缓存 crawl rows=" + up.rows + " → " + up.path);
      log("请求 /index/rebuild …");
      const rebResp = await bridgeFetch("/index/rebuild", "POST", "{}");
      const reb = (rebResp && rebResp.json) || {};
      if (!rebResp.ok || (!reb.ok && !reb.started)) {
        const err = reb.error || rebResp.error || JSON.stringify(reb);
        log("重建未启动: " + err);
        return { ok: false, error: "rebuild not started: " + err, upload: up };
      }
      log("索引重建已在 bridge 后台启动，轮询状态…");
      let last = null;
      for (let i = 0; i < 120; i++) {
        await sleep(2000);
        const stResp = await bridgeFetch("/index/status", "GET");
        const st = (stResp && stResp.json) || { error: stResp && stResp.error };
        if (st.error && !st.running && st.last == null) {
          log("状态查询失败: " + st.error);
          break;
        }
        if (st.running) {
          if (i % 5 === 0) log("索引重建进行中…");
          continue;
        }
        last = st.last || {};
        if (last.ok) {
          log("索引重建成功 out=" + (last.out || ""));
          if (last.stats) {
            log(
              "stats files=" +
                last.stats.files +
                " dirs=" +
                last.stats.dirs +
                " snapshot=" +
                (last.stats.snapshot || "")
            );
          }
          if (last.stdout_tail) log("stdout: " + last.stdout_tail.slice(-500));
        } else {
          log("索引重建失败: " + (last.error || last.stderr_tail || JSON.stringify(last)));
        }
        break;
      }
      return {
        ok: !!(last && last.ok),
        upload: up,
        rebuild: last,
        error: last && last.ok ? undefined : (last && (last.error || last.stderr_tail)) || "rebuild status unknown"
      };
    } catch (e) {
      log("上传/重建异常: " + (e.message || e) + "（确认 bridge 已通过 scripts/start_connector.ps1 启动）");
      return { ok: false, error: String(e.message || e) };
    } finally {
      state.indexBusy = false;
      render();
    }
  }

  function bridgeFetch(path, method, body) {
    return new Promise((resolve) => {
      safeRuntimeSendMessage(
        {
          type: "bridge-fetch",
          path,
          method: method || "GET",
          headers: { "Content-Type": "application/json" },
          body: body != null ? body : undefined
        },
        (resp, runtimeError) => {
          if (runtimeError) {
            resolve({ ok: false, error: runtimeError.message });
            return;
          }
          resolve(resp || { ok: false, error: "no response" });
        }
      );
    });
  }

  function applyPollState(resp, runtimeError, verbose) {
    if (state.contextInvalidated) {
      render();
      return;
    }
    const previous = state.connection;
    if (runtimeError || !resp || !resp.ok) {
      state.connection = "error";
      state.connectionMessage = runtimeError
        ? runtimeError.message
        : (resp && resp.error) || "本机 bridge 无响应";
      if (verbose || previous !== "error") log("Connector 异常: " + state.connectionMessage);
    } else {
      state.connection = "ready";
      state.connectionMessage = resp.pendingCount
        ? `Bridge 在线 · ${resp.pendingCount} 个待取任务包`
        : "Bridge 在线";
      if (verbose || previous !== "ready") log(state.connectionMessage);
      if (resp.note && verbose) log(resp.note);
      if (resp.imported && resp.imported.length) log("已接收任务包: " + resp.imported.join(", "));
    }
    if (state.running || state.ignoreStorageReload) {
      render();
      return;
    }
    loadState().then(render);
  }

  function refreshConnector() {
    safeRuntimeSendMessage({ type: "poll-now", force: false }, (resp, runtimeError) => {
      applyPollState(resp, runtimeError, true);
    });
  }

  function refreshStoredConnection() {
    safeRuntimeSendMessage({ type: "get-last-poll" }, (resp, runtimeError) => {
      applyPollState(resp, runtimeError, false);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function mount() {
    if (document.getElementById("bpt-root")) return;
    const root = document.createElement("div");
    root.id = "bpt-root";
    document.documentElement.appendChild(root);
    // 简单拖动
    let drag = null;
    root.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".bpt-header")) return;
      if (e.target.tagName === "BUTTON") return;
      drag = {
        x: e.clientX,
        y: e.clientY,
        top: root.offsetTop,
        left: root.offsetLeft
      };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      root.style.top = drag.top + (e.clientY - drag.y) + "px";
      root.style.right = "auto";
      root.style.left = drag.left + (e.clientX - drag.x) + "px";
    });
    window.addEventListener("mouseup", () => {
      drag = null;
    });
  }

  async function handlePanRpc(op, params) {
    params = params || {};
    if (op === "list") {
      const dir = params.dir || "/";
      const maxEntries = Math.min(Number(params.max_entries) || 2000, 5000);
      const recursive = !!params.recursive;
      if (!recursive) {
        const items = await listDir(dir);
        const slim = items.slice(0, maxEntries).map((it) => ({
          path: it.path,
          name: it.server_filename,
          isdir: it.isdir === 1 || it.isdir === "1" ? 1 : 0,
          size: Number(it.size) || 0,
          mtime: it.server_mtime || 0,
          md5: it.md5 || ""
        }));
        return {
          ok: true,
          result: {
            dir,
            count: slim.length,
            truncated: items.length > maxEntries,
            items: slim
          }
        };
      }
      // 浅递归：BFS，限制条数
      const out = [];
      const q = [dir];
      const seen = new Set([dir]);
      while (q.length && out.length < maxEntries) {
        const d = q.shift();
        let items;
        try {
          items = await listDir(d);
        } catch (e) {
          out.push({ path: d, error: String(e.message || e) });
          continue;
        }
        for (const it of items) {
          if (out.length >= maxEntries) break;
          const isDir = it.isdir === 1 || it.isdir === "1";
          out.push({
            path: it.path,
            name: it.server_filename,
            isdir: isDir ? 1 : 0,
            size: Number(it.size) || 0,
            mtime: it.server_mtime || 0,
            md5: it.md5 || ""
          });
          if (isDir && !seen.has(it.path)) {
            seen.add(it.path);
            q.push(it.path);
          }
        }
      }
      return {
        ok: true,
        result: {
          dir,
          recursive: true,
          count: out.length,
          truncated: out.length >= maxEntries,
          items: out
        }
      };
    }
    if (op === "exists") {
      const p = params.path;
      if (!p) return { ok: false, error: "path required" };
      const ex = await pathExists(p);
      return { ok: true, result: { path: p, exists: ex } };
    }
    if (op === "search") {
      const key = params.key;
      if (!key) return { ok: false, error: "key required" };
      const dir = params.dir || "/";
      const num = Math.min(Number(params.num) || 100, 200);
      const u =
        "/api/search?key=" +
        encodeURIComponent(key) +
        "&dir=" +
        encodeURIComponent(dir) +
        "&recursion=1&num=" +
        num +
        "&page=1&web=1&clienttype=0&app_id=250528";
      const r = await fetch(u, { credentials: "same-origin" }).then((x) => x.json());
      if (r.errno !== 0) return { ok: false, error: "search errno=" + r.errno };
      const list = (r.list || []).map((it) => ({
        path: it.path,
        name: it.server_filename,
        isdir: it.isdir === 1 || it.isdir === "1" ? 1 : 0,
        size: Number(it.size) || 0,
        md5: it.md5 || ""
      }));
      return { ok: true, result: { key, dir, count: list.length, items: list } };
    }
    // 远程索引刷新：agent 经 bridge pan-rpc 触发（不弹 confirm）
    if (op === "crawl_start" || op === "crawl-start") {
      const r = startCrawl({
        silent: true,
        autoIndex: !!(params && (params.auto_index || params.autoIndex)),
        concurrency: params && params.concurrency
      });
      if (!r.ok) return { ok: false, error: r.error };
      const st = window.BptCrawl ? window.BptCrawl.status() : null;
      return {
        ok: true,
        result: {
          started: true,
          auto_index: !!(params && (params.auto_index || params.autoIndex)),
          status: st
        }
      };
    }
    if (op === "crawl_status" || op === "crawl-status") {
      if (!window.BptCrawl) return { ok: false, error: "BptCrawl not loaded" };
      return {
        ok: true,
        result: {
          crawl: window.BptCrawl.status(),
          crawlBusy: state.crawlBusy,
          indexBusy: state.indexBusy,
          taskRunning: state.running
        }
      };
    }
    if (op === "crawl_stop" || op === "crawl-stop") {
      stopCrawl();
      return { ok: true, result: { abort_requested: true } };
    }
    if (op === "crawl_upload_rebuild" || op === "crawl-upload-rebuild") {
      // 可能较久（上传几十 MB + 轮询 rebuild）；bridge wait 默认 90s 可能不够，
      // 故只负责启动：上传后 kick rebuild，不在此 RPC 内等 rebuild 结束。
      if (!window.BptCrawl) return { ok: false, error: "BptCrawl not loaded" };
      const s = window.BptCrawl.status();
      if (s.running) return { ok: false, error: "crawl still running" };
      if (!s.entries) return { ok: false, error: "no crawl data" };
      // fire-and-forget 完整上传+轮询；RPC 立即返回「已受理」
      uploadAndRebuildIndex({ silent: true }).then((r) => {
        log(
          "远程 crawl_upload_rebuild 结束 ok=" +
            !!(r && r.ok) +
            (r && r.error ? " err=" + r.error : "")
        );
      });
      return {
        ok: true,
        result: {
          accepted: true,
          entries: s.entries,
          finished: s.finished,
          md5Missing: s.md5Missing,
          note: "upload+rebuild running in page; poll GET /index/status"
        }
      };
    }
    if (op === "panel_log" || op === "panel-log") {
      const n = Math.min(Number(params && params.n) || 80, 200);
      return {
        ok: true,
        result: {
          lines: state.log.slice(-n),
          total: state.log.length
        }
      };
    }
    if (op === "upload" || op === "upload_file") {
      try {
        const r = await uploadOne(params);
        return { ok: !!(r && r.ok !== false), result: r };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    if (op === "download" || op === "download_file") {
      try {
        const r = await downloadOne(params);
        return { ok: !!(r && r.ok !== false), result: r };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    if (op === "pack_status" || op === "pack-status") {
      // 优先内存；否则读 storage（F5 后仍可看到 failed.result）
      let packs = state.packs;
      let activePackId = state.activePackId;
      if (!packs || !Object.keys(packs).length) {
        const data = await chrome.storage.local.get(["packs", "activePackId"]);
        packs = data.packs || {};
        activePackId = data.activePackId;
      }
      const wantId = (params && (params.id || params.pack_id)) || activePackId;
      const summarize = (pack) => {
        if (!pack) return null;
        const counts = { pending: 0, approved: 0, done: 0, failed: 0, rejected: 0, other: 0 };
        const failed = [];
        const done = [];
        for (const t of pack.tasks || []) {
          const st = t.status || "pending";
          if (counts[st] != null) counts[st]++;
          else counts.other++;
          if (st === "failed") {
            failed.push({
              id: t.id,
              op: t.op,
              path: t.path,
              title: t.title,
              error: (t.result && (t.result.error || t.result.reason)) || null,
              result: t.result || null
            });
          }
          if (st === "done") {
            done.push({
              id: t.id,
              skipped: !!(t.result && t.result.skipped),
              reason: t.result && t.result.reason
            });
          }
        }
        return {
          id: pack.id,
          title: pack.title,
          counts,
          failed,
          done_sample: done.slice(0, 10),
          done_total: done.length
        };
      };
      if (wantId && packs[wantId]) {
        return { ok: true, result: { activePackId: wantId, pack: summarize(packs[wantId]) } };
      }
      const all = Object.keys(packs).map((id) => summarize(packs[id]));
      return {
        ok: true,
        result: {
          activePackId,
          pack_ids: Object.keys(packs),
          packs: all
        }
      };
    }
    return { ok: false, error: "unknown op: " + op };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "packs-updated") {
      loadState().then(render);
      return;
    }
    if (msg && msg.type === "auto-run-pack") {
      handleAutoRunPack(msg.id)
        .then((r) => sendResponse(r || { ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    if (msg && msg.type === "connector-ui-status") {
      sendResponse({ ok: true, result: getConnectorView() });
      return;
    }
    if (msg && msg.type === "pan-rpc") {
      handlePanRpc(msg.op, msg.params)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!(changes.packs || changes.activePackId)) return;
    // 执行中或本面板刚写入 storage 时，禁止用磁盘快照覆盖内存（否则 done 被冲掉、requires 误判）
    if (state.running || state.ignoreStorageReload) return;
    loadState().then(render);
  });

  // 页内兜底轮询 pan-rpc：经 background bridge-fetch（content 直连 127.0.0.1 无 CORS）。
  // MV3 SW 休眠时若本页仍开着，由此通道消费队列；与 background pollPanRpc 双通道，先取先答。
  let panRpcBusy = false;
  async function pollPanRpcFromPage() {
    if (panRpcBusy || state.contextInvalidated) return;
    panRpcBusy = true;
    try {
      const pendingResp = await bridgeFetch("/pan/rpc/pending", "GET");
      if (!pendingResp || !pendingResp.ok || !pendingResp.json) return;
      const reqs = pendingResp.json.requests || [];
      for (const req of reqs) {
        let answer;
        try {
          answer = await handlePanRpc(req.op, req.params || {});
        } catch (e) {
          answer = { ok: false, error: String(e.message || e) };
        }
        await bridgeFetch(
          "/pan/rpc/result",
          "POST",
          JSON.stringify({
            id: req.id,
            ok: !!(answer && answer.ok),
            result: answer && answer.result,
            error: answer && answer.error
          })
        );
      }
    } catch (_) {
      // bridge 未启动 / SW 未就绪时静默
    } finally {
      panRpcBusy = false;
    }
  }

  mount();
  loadState().then(() => {
    render();
    log(
      "面板已就绪 version=" +
        chrome.runtime.getManifest().version +
        "（connector 模式：CLI --auto 任务将自动执行）。"
    );
    refreshConnector();
    if (state.contextInvalidated) return;
    state.connectorTimer = setInterval(refreshStoredConnection, 3000);
    pollPanRpcFromPage();
    state.panRpcTimer = setInterval(pollPanRpcFromPage, 1500);
    // 启动时若本地已有 auto+approved，补跑
    setTimeout(() => {
      if (state.contextInvalidated) return;
      for (const id of Object.keys(state.packs || {})) {
        const p = state.packs[id];
        if (
          p &&
          (p.auto || p.auto_execute) &&
          (p.tasks || []).some((t) => t.status === "approved")
        ) {
          handleAutoRunPack(id);
          break;
        }
      }
    }, 800);
  });
})();
