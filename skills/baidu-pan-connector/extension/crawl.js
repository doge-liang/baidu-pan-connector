// 百度网盘全盘抓取（扩展内嵌，不自动启动）
// 同源 /api/list；产出与 scripts/baidu-pan-crawl.js 相同的列式 JSON。

(function () {
  if (window.BptCrawl) return;

  const state = {
    entries: [],
    queue: [],
    visited: null,
    done: 0,
    running: false,
    finished: false,
    aborted: false,
    errors: [],
    rateHits: 0,
    workers: 0,
    concurrency: 10
  };

  async function panList(dir) {
    const out = [];
    let start = 0;
    for (let page = 0; page < 400; page++) {
      if (state.aborted) break;
      let list = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (state.aborted) break;
        const u =
          "/api/list?dir=" +
          encodeURIComponent(dir) +
          "&order=name&desc=0&start=" +
          start +
          "&limit=1000&web=1&clienttype=0&showempty=0&app_id=250528";
        let r;
        try {
          r = await fetch(u, { credentials: "include" }).then((x) => x.json());
        } catch (e) {
          r = { errno: -999, msg: String(e) };
        }
        if (r.errno === 0) {
          list = r.list || [];
          break;
        }
        state.rateHits++;
        await new Promise((s) => setTimeout(s, 800 * Math.pow(2, attempt)));
        if (attempt === 5) state.errors.push({ dir, errno: r.errno });
      }
      if (list === null) break;
      out.push(...list);
      if (list.length < 1000) break;
      start += 1000;
    }
    return out;
  }

  async function worker() {
    state.workers++;
    try {
      while (!state.aborted) {
        const job = state.queue.shift();
        if (!job) break;
        const list = await panList(job.dir);
        for (const e of list) {
          state.entries.push({
            path: e.path,
            name: e.server_filename,
            isdir: e.isdir,
            size: e.size,
            mtime: e.server_mtime,
            md5: e.isdir ? "" : e.md5 || "",
            depth: job.depth + 1
          });
          if (e.isdir && !state.visited.has(e.path)) {
            state.visited.add(e.path);
            state.queue.push({ dir: e.path, depth: job.depth + 1 });
          }
        }
        state.done++;
      }
    } finally {
      state.workers--;
    }
  }

  function reset() {
    state.entries = [];
    state.queue = [{ dir: "/", depth: 0 }];
    state.visited = new Set(["/"]);
    state.done = 0;
    state.running = false;
    state.finished = false;
    state.aborted = false;
    state.errors = [];
    state.rateHits = 0;
    state.workers = 0;
  }

  function status() {
    const files = state.entries.filter((e) => !e.isdir);
    const withMd5 = files.filter((e) => e.md5).length;
    return {
      done: state.done,
      queue: state.queue.length,
      entries: state.entries.length,
      dirs: state.entries.length - files.length,
      files: files.length,
      md5Ok: withMd5,
      md5Missing: files.length - withMd5,
      running: state.running,
      finished: state.finished,
      aborted: state.aborted,
      rateHits: state.rateHits,
      errors: state.errors.length,
      workers: state.workers
    };
  }

  function buildPayload() {
    const files = state.entries.filter((e) => !e.isdir);
    const missing = files.filter((e) => !e.md5).length;
    return {
      generated_at: new Date().toISOString(),
      root: "/",
      total: state.entries.length,
      dirs: state.entries.length - files.length,
      md5_missing: missing,
      columns: ["path", "isdir", "size", "mtime", "md5"],
      rows: state.entries.map((e) => [
        e.path,
        e.isdir ? 1 : 0,
        e.size,
        e.mtime,
        e.md5 || ""
      ])
    };
  }

  function downloadJson() {
    const payload = buildPayload();
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "baidu-pan-crawl.json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 15000);
    return {
      total: payload.total,
      dirs: payload.dirs,
      md5_missing: payload.md5_missing
    };
  }

  async function start(concurrency) {
    if (state.running) throw new Error("抓取已在进行");
    reset();
    state.running = true;
    state.concurrency = concurrency || 10;
    const n = state.concurrency;
    const jobs = [];
    for (let i = 0; i < n; i++) jobs.push(worker());
    await Promise.all(jobs);
    state.running = false;
    state.finished = !state.aborted;
    return status();
  }

  function abort() {
    state.aborted = true;
  }

  window.BptCrawl = {
    start,
    abort,
    status,
    buildPayload,
    downloadJson,
    reset
  };
})();
