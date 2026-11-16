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

export const API_PATH = "/admin/callers/api"

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

    return false
  }

  return { handle, storePath }
}
