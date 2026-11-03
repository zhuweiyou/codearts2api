/**
 * 调用方管理后台（`/admin/callers`）。
 *
 * 与 `caller-gate.js` 的分工：
 *   - `caller-gate.js` 只管**运行时判定**（鉴权、白名单、用量落盘），零管理面。
 *   - 本文件管**管理面**：分组、key、白名单的增删改查 + 一个网页。
 *
 * 为什么单独一个文件：管理面要改的东西（HTML、表单、以及会写 config 的代码）
 * 一行都不该出现在每个请求都要跑的热路径上。另外它不进上游的 `src/`，升级冲突面
 * 只有 server.js 里那几行 patch。
 *
 * 鉴权：本模块**不做**鉴权，依赖 server.js 里已有的管理端鉴权门
 * （`needsAdminAuth("/admin/callers")` 恒为 true，未登录会被 302 到登录页）。
 * 自己再判一遍没有意义，反而会重复实现一套容易写错的判定。
 */

import { createHash, randomBytes } from "node:crypto"
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const PAGE_PATH = "/admin/callers"
export const API_PATH = "/admin/callers/api"
export const LINK_PATH = "/admin/callers-link.js"

const BODY_LIMIT = 1 << 20
const KEY_PREFIX = "p_"
const STORE_VERSION = 1
const STORE_COMMENT =
  "groups[].allow / deny 支持 `*`、`provider/*`、完整模型名。" +
  "aggregate/* 与 jet-hub-auto/* 在白名单不是 * 时必须显式列出才可用。"

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

/** 43 位 base64url：与 `auth.js` 的 `KEY_PATTERN` 同形，不会因为长度被别的层拦掉。 */
function mintKey() {
  return KEY_PREFIX + randomBytes(32).toString("base64url").slice(0, 41)
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  })
  response.end(body)
}

function sendHtml(response, html) {
  const body = Buffer.from(html, "utf8")
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  })
  response.end(body)
}

async function readJson(request, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error("请求体过大")
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function normalizeAllow(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    const value = String(item ?? "").trim()
    if (!value) continue
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/**
 * 把一行用量记录压成按 caller 汇总。
 * 只做加总，不做二次解释——字段口径与 `caller-usage/*.jsonl` 完全一致。
 */
function aggregateUsage(rows) {
  const map = new Map()
  for (const row of rows) {
    const id = row.caller ?? "unknown"
    let item = map.get(id)
    if (!item) {
      item = {
        caller: id,
        name: row.name ?? "",
        group: row.group ?? "",
        calls: 0,
        inTokens: 0,
        outTokens: 0,
        errors: 0,
        models: new Set(),
        lastTs: "",
      }
      map.set(id, item)
    }
    item.calls += 1
    item.inTokens += Number(row.in_tokens ?? 0) || 0
    item.outTokens += Number(row.out_tokens ?? 0) || 0
    if (Number(row.status) >= 400) item.errors += 1
    if (row.model) item.models.add(String(row.model))
    if (row.ts && row.ts > item.lastTs) item.lastTs = row.ts
  }
  return [...map.values()].map((item) => ({ ...item, models: [...item.models] })).sort((a, b) => b.calls - a.calls)
}

/**
 * 按模型汇总（谁被调得最多、哪个模型最贵）。
 *
 * `byCaller` 里记每个 key 对该模型的调用次数，用来回答「这个模型是谁在烧」。
 */
function aggregateByModel(rows) {
  const map = new Map()
  for (const row of rows) {
    const model = String(row.model ?? "?")
    let item = map.get(model)
    if (!item) {
      item = { model, calls: 0, inTokens: 0, outTokens: 0, errors: 0, msSum: 0, msCount: 0, byCaller: {} }
      map.set(model, item)
    }
    item.calls += 1
    item.inTokens += Number(row.in_tokens ?? 0) || 0
    item.outTokens += Number(row.out_tokens ?? 0) || 0
    if (Number(row.status) >= 400) item.errors += 1
    const ms = Number(row.ms ?? 0) || 0
    if (ms > 0) {
      item.msSum += ms
      item.msCount += 1
    }
    const caller = String(row.caller ?? "unknown")
    item.byCaller[caller] = (item.byCaller[caller] ?? 0) + 1
  }
  return [...map.values()]
    .map((item) => ({
      ...item,
      avgMs: item.msCount > 0 ? Math.round(item.msSum / item.msCount) : null,
    }))
    .sort((a, b) => b.calls - a.calls)
}

export function createCallerAdmin(options = {}) {
  const home = options.home
  const logger = options.logger ?? console
  const storePath = join(home, "caller-keys.json")
  const logDir = join(home, "caller-usage")
  const gatewayPort = process.env.DSH_OPENAI_GATEWAY_PORT || "8326"
  const masterKeyPath = options.masterKeyPath ?? join(home, "openai-gateway", "api-key")

  /**
   * 读配置。文件不存在视为「还没建过」（空结构，不是错误）。
   *
   * ⚠️ 异步：这些接口虽在管理面（并发不高），但读的可能是 300KB+ 的文件；
   *    同步读会在那几十毫秒里把整个进程（包括 `/v1` 推理流）钉住。
   */
  async function readStore() {
    let text
    try {
      text = await readFile(storePath, "utf8")
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      return { version: STORE_VERSION, _comment: STORE_COMMENT, groups: [], keys: [] }
    }
    const parsed = JSON.parse(text)
    return {
      version: parsed.version ?? STORE_VERSION,
      _comment: parsed._comment ?? STORE_COMMENT,
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
    }
  }

  /**
   * 原子写：先写旁路文件再 rename，读侧永远看不到半截 JSON。
   *
   * 旁路文件名带随机后缀：两个并发的保存请求各写各的临时文件，rename 本身是原子的，
   * 不会出现「A 写完临时文件、B 覆盖同一临时文件、A 把 B 的内容 rename 走」这种串味。
   */
  async function writeStore(data) {
    const text = JSON.stringify(data, null, 2) + "\n"
    const tmp = `${storePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
    await writeFile(tmp, text, { mode: 0o600 })
    await rename(tmp, storePath)
  }

  function publicKey(key) {
    return {
      id: key.id,
      name: key.name ?? key.id,
      group: key.group,
      enabled: key.enabled !== false,
      createdAt: key.createdAt ?? null,
      sha: String(key.sha256 ?? "").slice(0, 8),
    }
  }

  /**
   * 拉网关的模型清单，供白名单勾选。拿不到就返回空数组，页面自动退回手填。
   *
   * ⚠️ 必须缓存。「state」每次都要 210 个模型的完整清单，而 /v1/models 的响应
   * 是 65KB、进程冷启动后首次要 ~1.0s；每次打开弹窗都现拉一遍，用户就会感觉
   * 「点开很慢」（实测 state 冷 1.02s / 热 0.03s，热的快是因为上游有缓存）。
   * 模型目录的粒度是分钟级变化（要 /admin 手动开关才会变），10 秒 TTL 足够新鲜。
   * 失败也缓存（15s），避免网关挂掉时每次点击都卡满 8 秒超时。
   */
  let modelsCache = { at: 0, ids: null }
  const MODELS_TTL_MS = 10_000
  const MODELS_FAIL_TTL_MS = 15_000

  async function listModels() {
    const now = Date.now()
    if (modelsCache.ids && now - modelsCache.at < (modelsCache.ids.length ? MODELS_TTL_MS : MODELS_FAIL_TTL_MS)) {
      return modelsCache.ids
    }
    try {
      let key
      try {
        key = (await readFile(masterKeyPath, "utf8")).trim()
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
        modelsCache = { at: now, ids: [] }
        return []
      }
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        modelsCache = { at: now, ids: [] }
        return []
      }
      const payload = await res.json()
      const ids = [...new Set((payload.data ?? []).map((m) => String(m.id)).filter(Boolean))].sort()
      modelsCache = { at: now, ids }
      return ids
    } catch (error) {
      logger?.warn?.(`[caller-admin] 拉模型清单失败：${String(error)}`)
      modelsCache = { at: now, ids: [] }
      return []
    }
  }

  /**
   * 读某天的 usage JSONL。
   *
   * ⚠️ 必须按「文件大小 + mtime」缓存解析结果。当日文件会有 300KB+ 且持续追加，
   * 每次打开弹窗都 readFileSync + split + JSON.parse 一遍（约 1400 行）纯属浪费，
   * 而这份数据在两次点击之间的变化通常只有个位数行。缓存未命中时才重新解析。
   *
   * 只缓存最近一天（Map 上限 2 个键），避免翻历史时把内存堆起来。
   */
  const usageCache = new Map() // day -> { sig, rows }
  const USAGE_CACHE_MAX = 2

  async function readUsage(day) {
    const path = join(logDir, `${day}.jsonl`)

    let st
    try {
      st = await stat(path)
    } catch (error) {
      if (error?.code === "ENOENT") return []
      throw error
    }
    const sig = `${st.size}:${st.mtimeMs}`
    const hit = usageCache.get(day)
    if (hit && hit.sig === sig) return hit.rows

    let text
    try {
      text = await readFile(path, "utf8")
    } catch (error) {
      // stat 成功但紧接着文件被删（并发清理 / 跨天滚动）：当作这一天没有流水，
      // 而不是把一次管理端查询变成 500。
      if (error?.code === "ENOENT") return []
      throw error
    }

    const rows = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)

    usageCache.set(day, { sig, rows })
    // 简单的 LRU 上界：超出就丢最早插入的键。
    while (usageCache.size > USAGE_CACHE_MAX) {
      usageCache.delete(usageCache.keys().next().value)
    }
    return rows
  }

  function today() {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, "0")
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }

  /** 磁盘上实际有流水的日期（倒序），供前端日期选择器直接列出，避免瞎猜。 */
  async function availableDays() {
    try {
      return (await readdir(logDir))
        .map((name) => (/^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name) ?? [])[1])
        .filter(Boolean)
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  async function handleApi(request, response) {
    let payload
    try {
      payload = await readJson(request)
    } catch (error) {
      sendJson(response, 400, { error: `请求体无法解析：${String(error)}` })
      return
    }
    const action = String(payload.action ?? "")

    try {
      if (action === "state") {
        const store = await readStore()
        const day = typeof payload.day === "string" && payload.day ? payload.day : today()
        sendJson(response, 200, {
          groups: store.groups,
          keys: store.keys.map(publicKey),
          models: await listModels(),
          usage: { day, rows: aggregateUsage(await readUsage(day)) },
          storePath,
        })
        return
      }

      /**
       * 调用记录（逐次明细 + 按模型汇总 + 可选多日范围）。
       *
       * 口径：
       *   - `days`：要查的日期数组，缺省为今天；最多 31 天（防止一次读爆磁盘）。
       *   - `filter`：`{ caller, model, status }`，任一为空即不过滤。
       *   - `limit`：明细最多返回多少条（默认 300，上限 2000），按时间**倒序**。
       *   - 汇总（byCaller / byModel）永远基于**过滤后的全集**，不受 limit 影响 ——
       *     否则「翻到第 2 页时汇总数字变了」会让人以为数据在跳。
       */
      if (action === "records") {
        const wantDays =
          Array.isArray(payload.days) && payload.days.length > 0
            ? payload.days
                .map((d) => String(d))
                .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
                .slice(0, 31)
            : [today()]
        const filter = payload.filter && typeof payload.filter === "object" ? payload.filter : {}
        const limit = Math.min(Math.max(Number(payload.limit ?? 300) || 300, 1), 2000)

        const all = []
        for (const day of wantDays) {
          for (const row of await readUsage(day)) all.push({ ...row, day })
        }

        const callerWant = String(filter.caller ?? "").trim()
        const modelWant = String(filter.model ?? "").trim()
        const statusWant = String(filter.status ?? "").trim()
        const kept = all.filter((row) => {
          if (callerWant && String(row.caller ?? "") !== callerWant) return false
          if (modelWant && String(row.model ?? "") !== modelWant) return false
          if (statusWant === "error" && Number(row.status ?? 0) < 400) return false
          if (statusWant === "ok" && Number(row.status ?? 0) >= 400) return false
          return true
        })

        const sorted = kept.slice().sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")))
        sendJson(response, 200, {
          days: wantDays,
          total: kept.length,
          shown: Math.min(limit, kept.length),
          rows: sorted.slice(0, limit),
          byCaller: aggregateUsage(kept),
          byModel: aggregateByModel(kept),
          availableDays: await availableDays(),
        })
        return
      }

      if (action === "key.add") {
        const name = String(payload.name ?? "").trim()
        const group = String(payload.group ?? "").trim()
        if (!name) return sendJson(response, 400, { error: "名字不能为空" })
        const store = await readStore()
        if (!store.groups.some((g) => g.name === group)) {
          return sendJson(response, 400, { error: `分组 ${group} 不存在` })
        }
        const secret = mintKey()
        const entry = {
          id: `k_${randomBytes(3).toString("hex")}`,
          name,
          group,
          sha256: sha256(secret),
          enabled: typeof payload.enabled === "boolean" ? payload.enabled : true,
          createdAt: new Date().toISOString(),
        }
        store.keys.push(entry)
        await writeStore(store)
        logger?.info?.(`[caller-admin] 新增调用方 ${entry.id}（${name} / ${group}）`)
        // 明文只在这一行响应里出现一次，之后任何接口都拿不到。
        sendJson(response, 200, { key: entry.id, secret, group })
        return
      }

      if (action === "key.update") {
        const id = String(payload.id ?? "")
        const store = await readStore()
        const entry = store.keys.find((k) => k.id === id)
        if (!entry) return sendJson(response, 404, { error: `key ${id} 不存在` })
        if (typeof payload.name === "string" && payload.name.trim()) entry.name = payload.name.trim()
        if (typeof payload.group === "string" && payload.group) {
          if (!store.groups.some((g) => g.name === payload.group)) {
            return sendJson(response, 400, { error: `分组 ${payload.group} 不存在` })
          }
          entry.group = payload.group
        }
        if (typeof payload.enabled === "boolean") entry.enabled = payload.enabled
        await writeStore(store)
        sendJson(response, 200, { ok: true, key: publicKey(entry) })
        return
      }

      if (action === "key.rm") {
        const id = String(payload.id ?? "")
        const store = await readStore()
        const before = store.keys.length
        store.keys = store.keys.filter((k) => k.id !== id)
        if (store.keys.length === before) return sendJson(response, 404, { error: `key ${id} 不存在` })
        await writeStore(store)
        logger?.info?.(`[caller-admin] 删除调用方 ${id}`)
        sendJson(response, 200, { ok: true })
        return
      }

      if (action === "group.save") {
        const name = String(payload.name ?? "").trim()
        if (!name) return sendJson(response, 400, { error: "分组名不能为空" })
        if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name)) {
          return sendJson(response, 400, { error: "分组名只能用字母数字和 _ . -，最长 40" })
        }
        const store = await readStore()
        const existing = store.groups.find((g) => g.name === name)
        const allow = normalizeAllow(payload.allow)
        if (!allow.length) return sendJson(response, 400, { error: "白名单不能为空（全放行请填 *）" })
        if (existing) {
          existing.desc = String(payload.desc ?? existing.desc ?? "")
          existing.allow = allow
        } else {
          store.groups.push({ name, desc: String(payload.desc ?? ""), allow })
        }
        await writeStore(store)
        logger?.info?.(`[caller-admin] 保存分组 ${name}（allow=${allow.length} 条）`)
        sendJson(response, 200, { ok: true })
        return
      }

      if (action === "group.rm") {
        const name = String(payload.name ?? "")
        const store = await readStore()
        // 删掉还在被引用的分组 = 那批 key 全部变成「分组不存在一律拒绝」，
        // 与其让运行时 403 让人一头雾水，不如在这里直接拒绝，并说清是谁在用。
        const users = store.keys.filter((k) => k.group === name).map((k) => k.name || k.id)
        if (users.length) {
          return sendJson(response, 400, {
            error: `分组 ${name} 仍被 ${users.length} 把 key 使用（${users.join("、")}），先改组或删掉它们`,
          })
        }
        const before = store.groups.length
        store.groups = store.groups.filter((g) => g.name !== name)
        if (store.groups.length === before) {
          return sendJson(response, 404, { error: `分组 ${name} 不存在` })
        }
        await writeStore(store)
        sendJson(response, 200, { ok: true })
        return
      }

      sendJson(response, 400, { error: `未知操作 ${action || "（空）"}` })
    } catch (error) {
      logger?.error?.(`[caller-admin] ${action} 失败：${String(error)}`)
      sendJson(response, 500, { error: String(error) })
    }
  }

  /**
   * @returns {Promise<boolean>} 是否已经处理了这个请求（true 时调用方直接 return）
   */
  async function handle(request, response, url) {
    const path = url.pathname

    if (path === API_PATH) {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "只支持 POST" })
        return true
      }
      await handleApi(request, response)
      return true
    }

    if (path === LINK_PATH) {
      const body = Buffer.from(LINK_JS, "utf8")
      response.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "content-length": String(body.length),
        "cache-control": "no-store",
      })
      response.end(body)
      return true
    }

    if (path === PAGE_PATH || path === `${PAGE_PATH}/`) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET" })
        response.end()
        return true
      }
      sendHtml(response, renderPage())
      return true
    }

    return false
  }

  return { handle, storePath }
}

/**
 * 注入到管理后台的入口脚本（`/admin/callers-link.js`）。
 *
 * 为什么要靠注入而不是改上游 UI：
 *   管理界面是 `public/upstream-jet-hub.js`（768 KB 的构建产物、且被 .gitignore），
 *   改它等于改依赖包，升级即失效。而 `public/admin.html` 是跟踪在仓库里的静态壳，
 *   在它末尾追加一行 <script> 就能拿到「页面已经在跑」的时机，改动面最小。
 *
 * 落点策略（按优先级）：顶部 header / 工具栏 / tablist → 都没有就固定右下角浮标。
 * 三种都是同一个 href，只是位置不同，任何 DOM 结构下都不会「找不到入口」。
 */
const LINK_JS = `(function () {
  var HREF = "/admin/callers";
  var SEL = "[data-c2a-callers]";
  var CSS = [
    "#c2a-callers-entry{position:fixed;right:18px;bottom:18px;z-index:50;display:inline-flex;",
    "align-items:center;gap:6px;padding:9px 15px;border-radius:999px;background:#4f8cff;",
    "color:#07142c;font:600 13px/1 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;",
    "text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.35)}",
    "#c2a-callers-entry:hover{filter:brightness(1.08)}",
    ".c2a-callers-inline{display:inline-flex;align-items:center;margin-left:10px;padding:6px 12px;",
    "border-radius:8px;border:1px solid #3d4759;background:#1c2230;color:#dbe4f3;",
    "font:600 12.5px/1 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;",
    "text-decoration:none;white-space:nowrap}",
    ".c2a-callers-inline:hover{border-color:#4f8cff;color:#fff}"
  ].join("");

  function ensureStyle() {
    if (document.getElementById("c2a-callers-css")) return;
    var style = document.createElement("style");
    style.id = "c2a-callers-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function makeLink(className, id, text) {
    var a = document.createElement("a");
    a.href = HREF;
    a.className = className;
    if (id) a.id = id;
    a.textContent = text;
    a.setAttribute("data-c2a-callers", "1");
    return a;
  }

  // 候选容器：只管「像导航栏」的元素，且高度不能太大（否则会把按钮塞到正文里）
  var CANDIDATES = [
    "header", "[role=banner]", "nav", "[role=tablist]",
    "[class*=header]", "[class*=topbar]", "[class*=top-bar]", "[class*=toolbar]",
    "[class*=nav]", "[class*=tabs]"
  ].join(",");

  function placeInline() {
    var scope = document.getElementById("admin-root") || document.body;
    var nodes = scope.querySelectorAll(CANDIDATES);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.querySelector(SEL)) return true;
      if (node.offsetHeight > 160) continue;
      if (node.offsetWidth < 200) continue;
      // 只往「容器自己直接持有文字/按钮」的节点里塞，避免塞进深层包裹层导致布局炸
      node.appendChild(makeLink("c2a-callers-inline", "", "调用方管理"));
      return true;
    }
    return false;
  }

  function placeFixed() {
    if (document.querySelector(SEL)) return true;
    document.body.appendChild(makeLink("", "c2a-callers-entry", "调用方管理"));
    return true;
  }

  function run() {
    ensureStyle();
    if (document.querySelector(SEL)) return true;
    return placeInline() || placeFixed();
  }

  function boot() {
    run();
    // SPA 是异步渲染的：首次可能只有一个「正在加载」占位。
    // ⚠️ 不能塞进去一次就 disconnect —— 切换页签/重新渲染会把我们的节点冲掉，
    //    入口会「点着点着就没了」。所以观察器常驻，只在节点消失时补回去。
    //    防自激：requestAnimationFrame 节流 + 只在 SEL 不存在时才动手，
    //    补一次后 SEL 就在了，下一次 mutation 直接 no-op，不会无限循环。
    var pending = false;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        if (!document.querySelector(SEL)) run();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();`

function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>调用方管理 · codearts2api</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b36; --text: #e6e9ef;
    --dim: #8b93a7; --accent: #4f8cff; --ok: #35c48a; --warn: #e8a33d; --bad: #e5606a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 80px; }
  header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 22px; }
  h1 { font-size: 19px; margin: 0; letter-spacing: .3px; }
  .sub { color: var(--dim); font-size: 12.5px; }
  .spacer { flex: 1; }
  h2 { font-size: 14px; margin: 26px 0 10px; color: var(--dim); font-weight: 600;
    letter-spacing: .6px; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
    border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line);
    vertical-align: top; }
  th { font-size: 12px; color: var(--dim); font-weight: 600; background: #141822; }
  tr:last-child td { border-bottom: none; }
  code, .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12.5px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { background: #1e2431; border: 1px solid var(--line); border-radius: 6px;
    padding: 1px 7px; font-size: 12px; font-family: ui-monospace, monospace; color: #b9c4d8; }
  .chip.wild { border-color: #3d4a63; color: var(--accent); }
  button { font: inherit; font-size: 13px; border-radius: 7px; border: 1px solid var(--line);
    background: #1c2230; color: var(--text); padding: 5px 11px; cursor: pointer; }
  button:hover { border-color: #3d4759; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #08142b;
    font-weight: 600; }
  button.danger { color: var(--bad); border-color: #4a2a30; }
  button.mini { padding: 2px 8px; font-size: 12px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; }
  .b-ok { background: rgba(53,196,138,.14); color: var(--ok); }
  .b-off { background: rgba(139,147,167,.14); color: var(--dim); }
  .b-bad { background: rgba(229,96,106,.14); color: var(--bad); }
  .toolbar { display: flex; gap: 8px; margin-top: 10px; }
  .empty { color: var(--dim); padding: 14px 12px; font-size: 13px; }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.62); display: none;
    align-items: center; justify-content: center; padding: 20px; z-index: 30; }
  .modal.on { display: flex; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    width: 100%; max-width: 620px; max-height: 86vh; overflow: auto; padding: 18px; }
  .card h3 { margin: 0 0 14px; font-size: 15px; }
  label { display: block; font-size: 12.5px; color: var(--dim); margin: 12px 0 5px; }
  input[type=text], select, textarea { width: 100%; background: #10141c; color: var(--text);
    border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px; font: inherit; }
  input[type=text]:focus, select:focus { outline: none; border-color: var(--accent); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
  .models { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px;
    max-height: 240px; overflow: auto; margin-top: 6px; background: #10141c; }
  .grp { margin: 8px 0 2px; color: var(--dim); font-size: 12px; font-family: ui-monospace, monospace; }
  .models label { display: flex; align-items: center; gap: 7px; margin: 3px 0; color: var(--text);
    font-size: 12.5px; font-family: ui-monospace, monospace; }
  .models input { margin: 0; accent-color: var(--accent); }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
  .secret { background: #10141c; border: 1px dashed #3d4759; border-radius: 8px;
    padding: 10px 12px; font-family: ui-monospace, monospace; font-size: 13px;
    word-break: break-all; color: var(--ok); margin: 8px 0; }
  .note { color: var(--dim); font-size: 12px; margin-top: 6px; }
  .err { color: var(--bad); font-size: 12.5px; margin-top: 10px; min-height: 18px; }
  .hint { color: var(--warn); font-size: 12.5px; }
  a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>调用方管理</h1>
    <span class="sub">分组决定能调哪些模型，key 决定谁在调</span>
    <span class="spacer"></span>
    <a href="/admin">← 返回后台</a>
  </header>

  <h2>分组</h2>
  <table><thead><tr>
    <th style="width:150px">分组名</th><th>说明</th><th>白名单</th><th style="width:120px">操作</th>
  </tr></thead><tbody id="groups"><tr><td colspan="4" class="empty">读取中…</td></tr></tbody></table>
  <div class="toolbar"><button class="primary" onclick="editGroup(null)">+ 新建分组</button></div>

  <h2>调用方 Key</h2>
  <table><thead><tr>
    <th style="width:110px">id</th><th style="width:150px">名字</th><th style="width:150px">分组</th>
    <th style="width:90px">状态</th><th>创建时间</th><th style="width:190px">操作</th>
  </tr></thead><tbody id="keys"><tr><td colspan="6" class="empty">读取中…</td></tr></tbody></table>
  <div class="toolbar"><button class="primary" onclick="addKey()">+ 新建 Key</button></div>

  <h2>用量</h2>
  <div class="sub" id="usageDay" style="margin-bottom:8px"></div>
  <table><thead><tr>
    <th style="width:110px">key</th><th style="width:150px">名字</th><th style="width:130px">分组</th>
    <th style="width:70px">次数</th><th style="width:90px">in</th><th style="width:90px">out</th>
    <th style="width:70px">错误</th><th>最近调用的模型</th>
  </tr></thead><tbody id="usage"><tr><td colspan="8" class="empty">读取中…</td></tr></tbody></table>
  <div class="note">流水按天落盘，路径 <code id="storePath">-</code> 同级 <code>caller-usage/</code>。</div>
</div>

<div class="modal" id="modal"><div class="card" id="card"></div></div>

<script>
let STATE = { groups: [], keys: [], models: [], usage: { day: '', rows: [] } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(payload) {
  const res = await fetch('${API_PATH}', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function chips(allow) {
  return '<div class="chips">' + allow.map((a) =>
    '<span class="chip' + (a.includes('*') ? ' wild' : '') + '">' + esc(a) + '</span>').join('') + '</div>';
}

function render() {
  const g = STATE.groups;
  document.getElementById('groups').innerHTML = g.length ? g.map((x) => \`
    <tr>
      <td class="mono">\${esc(x.name)}</td>
      <td>\${esc(x.desc || '')}</td>
      <td>\${chips(x.allow || [])}</td>
      <td>
        <button class="mini" onclick='editGroup(\${JSON.stringify(x.name)})'>编辑</button>
        <button class="mini danger" onclick='rmGroup(\${JSON.stringify(x.name)})'>删除</button>
      </td>
    </tr>\`).join('') : '<tr><td colspan="4" class="empty">还没有分组</td></tr>';

  const k = STATE.keys;
  document.getElementById('keys').innerHTML = k.length ? k.map((x) => \`
    <tr>
      <td class="mono">\${esc(x.id)}</td>
      <td>\${esc(x.name)}</td>
      <td class="mono">\${esc(x.group)}</td>
      <td>\${x.enabled ? '<span class="badge b-ok">启用中</span>' : '<span class="badge b-off">已停用</span>'}</td>
      <td class="mono sub">\${esc((x.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
      <td>
        <button class="mini" onclick='editKey(\${JSON.stringify(x.id)})'>编辑</button>
        <button class="mini" onclick='toggleKey(\${JSON.stringify(x.id)}, \${x.enabled ? 'false' : 'true'})'>\${x.enabled ? '停用' : '启用'}</button>
        <button class="mini danger" onclick='rmKey(\${JSON.stringify(x.id)})'>删除</button>
      </td>
    </tr>\`).join('') : '<tr><td colspan="6" class="empty">还没有 key</td></tr>';

  const u = STATE.usage;
  document.getElementById('usageDay').textContent = u.day ? ('统计日期 ' + u.day) : '';
  document.getElementById('usage').innerHTML = u.rows && u.rows.length ? u.rows.map((r) => \`
    <tr>
      <td class="mono">\${esc(r.caller)}</td>
      <td>\${esc(r.name)}</td>
      <td class="mono">\${esc(r.group)}</td>
      <td>\${r.calls}</td>
      <td class="mono">\${r.inTokens || '-'}</td>
      <td class="mono">\${r.outTokens || '-'}</td>
      <td>\${r.errors ? '<span class="badge b-bad">' + r.errors + '</span>' : '-'}</td>
      <td class="mono sub">\${esc((r.models || []).slice(0, 3).join(', '))}\${(r.models || []).length > 3 ? ' +' + ((r.models || []).length - 3) : ''}</td>
    </tr>\`).join('') : '<tr><td colspan="8" class="empty">今天还没有调用</td></tr>';

  document.getElementById('storePath').textContent = STATE.storePath || '-';
}

async function load() {
  STATE = await api({ action: 'state' });
  render();
}

const modal = document.getElementById('modal');
const card = document.getElementById('card');
function closeModal() { modal.classList.remove('on'); }
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

async function editGroup(name) {
  const group = name ? STATE.groups.find((g) => g.name === name) : { name: '', desc: '', allow: ['*'] };
  if (!group) return;
  const providers = {};
  for (const id of STATE.models) {
    const prefix = id.split('/')[0] || 'other';
    (providers[prefix] = providers[prefix] || []).push(id);
  }
  const selected = new Set(group.allow || []);
  const manual = (group.allow || []).filter((a) => a.includes('*') && a !== '*').join('\\n');

  card.innerHTML = \`
    <h3>\${name ? '编辑分组 ' + esc(name) : '新建分组'}</h3>
    <div class="grid">
      <div>
        <label>分组名（字母数字 _ . -）</label>
        <input id="gName" type="text" value="\${esc(group.name)}" \${name ? 'readonly style="opacity:.6"' : ''}>
      </div>
      <div>
        <label>说明</label>
        <input id="gDesc" type="text" value="\${esc(group.desc || '')}" placeholder="这个分组给谁用">
      </div>
    </div>
    <label>通配（每行一条，如 <code>codearts/*</code>、<code>*</code>）</label>
    <textarea id="gWild" rows="3" placeholder="codearts/*">\${esc(manual)}</textarea>
    <label>逐个勾选（网关当前 \${STATE.models.length} 个模型）</label>
    <div class="models" id="mList">
      \${Object.keys(providers).length ? Object.entries(providers).map(([p, ids]) => \`
        <div class="grp">\${esc(p)}</div>
        \${ids.map((id) => \`<label><input type="checkbox" value="\${esc(id)}" \${selected.has(id) ? 'checked' : ''}>\${esc(id)}</label>\`).join('')}
      \`).join('') : '<div class="empty">拉不到模型清单，请用上面的通配输入</div>'}
    </div>
    <div class="hint">提示：<code>aggregate/*</code> 与 <code>jet-hub-auto/*</code> 会跨渠道自动选号，白名单不是 <code>*</code> 时必须逐个列出才放行。</div>
    <div class="err" id="gErr"></div>
    <div class="row">
      <button onclick="closeModal()">取消</button>
      <button class="primary" onclick="saveGroup()">保存</button>
    </div>\`;
  modal.classList.add('on');
}

async function saveGroup() {
  const name = document.getElementById('gName').value.trim();
  const desc = document.getElementById('gDesc').value.trim();
  const wild = document.getElementById('gWild').value.split(/[\\n,]/).map((s) => s.trim()).filter(Boolean);
  const checked = [...document.querySelectorAll('#mList input:checked')].map((i) => i.value);
  const allow = [...new Set([...wild, ...checked])];
  try {
    await api({ action: 'group.save', name, desc, allow });
    closeModal();
    await load();
  } catch (e) {
    document.getElementById('gErr').textContent = e.message;
  }
}

async function rmGroup(name) {
  if (!confirm('删除分组 ' + name + '？')) return;
  try { await api({ action: 'group.rm', name }); await load(); }
  catch (e) { alert(e.message); }
}

function addKey() {
  if (!STATE.groups.length) return alert('先建一个分组');
  card.innerHTML = \`
    <h3>新建调用方 Key</h3>
    <label>名字（给谁用）</label>
    <input id="kName" type="text" placeholder="张三 / 前端小组">
    <label>分组</label>
    <select id="kGroup">\${STATE.groups.map((g) =>
      \`<option value="\${esc(g.name)}">\${esc(g.name)}\${g.desc ? ' — ' + esc(g.desc) : ''}</option>\`).join('')}</select>
    <div class="err" id="kErr"></div>
    <div class="row">
      <button onclick="closeModal()">取消</button>
      <button class="primary" onclick="saveKey()">生成</button>
    </div>\`;
  modal.classList.add('on');
  setTimeout(() => document.getElementById('kName').focus(), 30);
}

async function saveKey() {
  const name = document.getElementById('kName').value.trim();
  const group = document.getElementById('kGroup').value;
  try {
    const out = await api({ action: 'key.add', name, group });
    card.innerHTML = \`
      <h3>Key 已生成</h3>
      <div class="note">\${esc(name)} · 分组 <code>\${esc(out.group)}</code> · id <code>\${esc(out.key)}</code></div>
      <div class="secret" id="sec">\${esc(out.secret)}</div>
      <div class="hint">这串只显示这一次，关掉就找不回来了（库里只存 sha256）。</div>
      <div class="row">
        <button onclick="closeModal();load()">关闭</button>
        <button class="primary" onclick="copySec()">复制</button>
      </div>\`;
    await load();
  } catch (e) {
    document.getElementById('kErr').textContent = e.message;
  }
}

function copySec() {
  const text = document.getElementById('sec').textContent;
  navigator.clipboard.writeText(text).then(
    () => { document.querySelector('#card .row .primary').textContent = '已复制'; },
    () => { alert('复制失败，请手动选中'); });
}

function editKey(id) {
  const key = STATE.keys.find((k) => k.id === id);
  if (!key) return;
  card.innerHTML = \`
    <h3>编辑 \${esc(key.id)}</h3>
    <label>名字</label>
    <input id="eName" type="text" value="\${esc(key.name)}">
    <label>分组</label>
    <select id="eGroup">\${STATE.groups.map((g) =>
      \`<option value="\${esc(g.name)}" \${g.name === key.group ? 'selected' : ''}>\${esc(g.name)}</option>\`).join('')}</select>
    <div class="err" id="eErr"></div>
    <div class="row">
      <button onclick="closeModal()">取消</button>
      <button class="primary" onclick="saveKeyEdit(\${JSON.stringify(id)})">保存</button>
    </div>\`;
  modal.classList.add('on');
}

async function saveKeyEdit(id) {
  const name = document.getElementById('eName').value.trim();
  const group = document.getElementById('eGroup').value;
  try { await api({ action: 'key.update', id, name, group }); closeModal(); await load(); }
  catch (e) { document.getElementById('eErr').textContent = e.message; }
}

async function toggleKey(id, enabled) {
  try { await api({ action: 'key.update', id, enabled }); await load(); }
  catch (e) { alert(e.message); }
}

async function rmKey(id) {
  if (!confirm('删除 ' + id + '？用它的人会立刻 401。')) return;
  try { await api({ action: 'key.rm', id }); await load(); }
  catch (e) { alert(e.message); }
}

load().catch((e) => {
  document.getElementById('groups').innerHTML =
    '<tr><td colspan="4" class="empty">加载失败：' + esc(e.message) + '</td></tr>';
});
</script>
</body>
</html>`
}
