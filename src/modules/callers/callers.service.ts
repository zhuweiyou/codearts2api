/**
 * 调用方（caller）领域服务：分组 / key / 用量。
 *
 * - 纯业务与存储逻辑，不接触 HTTP（无 req/res）。
 * - 校验失败抛 {@link CallerAdminError}（带 status），由控制器转成响应。
 */
import { createHash, randomBytes } from "node:crypto"
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { AppError } from "../../core/errors.ts"

const KEY_PREFIX = "p_"
const STORE_VERSION = 1
const STORE_COMMENT =
  "groups[].allow / deny 支持 `*`、`provider/*`、完整模型名。" +
  "aggregate/* 与 jet-hub-auto/* 在白名单不是 * 时必须显式列出才可用。"

/** 业务校验错误（status 供统一错误中间件转成 HTTP）。 */
export class CallerAdminError extends AppError {
  constructor(status: number, message: string) {
    super(status, "caller_admin", message)
  }
}

const sha256 = (value: any) => createHash("sha256").update(String(value)).digest("hex")

/** 43 位 base64url：与上游 auth 的 KEY_PATTERN 同形。 */
function mintKey() {
  return KEY_PREFIX + randomBytes(32).toString("base64url").slice(0, 41)
}

function normalizeAllow(list: any): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const value = String(item ?? "").trim()
    if (!value) continue
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** 把一行条用量压成按 caller 汇总。 */
function aggregateUsage(rows: any[]) {
  const map = new Map<string, any>()
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
        models: new Set<string>(),
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

/** 按模型汇总。 */
function aggregateByModel(rows: any[]) {
  const map = new Map<string, any>()
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
    .map((item) => ({ ...item, avgMs: item.msCount > 0 ? Math.round(item.msSum / item.msCount) : null }))
    .sort((a, b) => b.calls - a.calls)
}

export function createCallersService(options: any = {}) {
  const home = options.home
  const logger = options.logger ?? console
  const storePath = join(home, "caller-keys.json")
  const logDir = join(home, "caller-usage")
  const gatewayPort = process.env.DSH_OPENAI_GATEWAY_PORT || "8326"
  const masterKeyPath = options.masterKeyPath ?? join(home, "openai-gateway", "api-key")

  async function readStore() {
    let text
    try {
      text = await readFile(storePath, "utf8")
    } catch (error: any) {
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

  async function writeStore(data: any) {
    const text = JSON.stringify(data, null, 2) + "\n"
    const tmp = `${storePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
    await writeFile(tmp, text, { mode: 0o600 })
    await rename(tmp, storePath)
  }

  function publicKey(key: any) {
    return {
      id: key.id,
      name: key.name ?? key.id,
      group: key.group,
      enabled: key.enabled !== false,
      createdAt: key.createdAt ?? null,
      sha: String(key.sha256 ?? "").slice(0, 8),
    }
  }

  // 模型目录缓存（10s 成功 / 15s 失败）
  let modelsCache: { at: number; ids: string[] | null } = { at: 0, ids: null }
  const MODELS_TTL_MS = 10_000
  const MODELS_FAIL_TTL_MS = 15_000
  async function listModels(): Promise<string[]> {
    const now = Date.now()
    if (modelsCache.ids && now - modelsCache.at < (modelsCache.ids.length ? MODELS_TTL_MS : MODELS_FAIL_TTL_MS)) {
      return modelsCache.ids
    }
    try {
      let key
      try {
        key = (await readFile(masterKeyPath, "utf8")).trim()
      } catch (error: any) {
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
      const payload: any = await res.json()
      const ids = [...new Set((payload.data ?? []).map((m: any) => String(m.id)).filter(Boolean))].sort() as string[]
      modelsCache = { at: now, ids }
      return ids
    } catch (error: any) {
      logger?.warn?.(`[callers] 拉模型清单失败：${String(error)}`)
      modelsCache = { at: now, ids: [] }
      return []
    }
  }

  // usage 解析缓存（按 size+mtime，最多 2 天）
  const usageCache = new Map<string, { sig: string; rows: any[] }>()
  const USAGE_CACHE_MAX = 2
  async function readUsage(day: string): Promise<any[]> {
    const path = join(logDir, `${day}.jsonl`)
    let st
    try {
      st = await stat(path)
    } catch (error: any) {
      if (error?.code === "ENOENT") return []
      throw error
    }
    const sig = `${st.size}:${st.mtimeMs}`
    const hit = usageCache.get(day)
    if (hit && hit.sig === sig) return hit.rows
    let text
    try {
      text = await readFile(path, "utf8")
    } catch (error: any) {
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
    while (usageCache.size > USAGE_CACHE_MAX) usageCache.delete(usageCache.keys().next().value as string)
    return rows
  }

  function today() {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }

  async function availableDays(): Promise<string[]> {
    try {
      return (await readdir(logDir))
        .map((name) => (/^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name) ?? [])[1])
        .filter(Boolean)
        .sort()
        .reverse() as string[]
    } catch {
      return []
    }
  }

  // ── 对外用例 ──

  async function state(day?: string) {
    const store = await readStore()
    const d = typeof day === "string" && day ? day : today()
    return {
      groups: store.groups,
      keys: store.keys.map(publicKey),
      models: await listModels(),
      usage: { day: d, rows: aggregateUsage(await readUsage(d)) },
      storePath,
    }
  }

  async function records(params: any = {}) {
    const wantDays: string[] =
      Array.isArray(params.days) && params.days.length > 0
        ? params.days
            .map((d: any) => String(d))
            .filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d))
            .slice(0, 31)
        : [today()]
    const filter = params.filter && typeof params.filter === "object" ? params.filter : {}
    const limit = Math.min(Math.max(Number(params.limit ?? 300) || 300, 1), 2000)
    const all: any[] = []
    for (const day of wantDays) for (const row of await readUsage(day)) all.push({ ...row, day })
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
    return {
      days: wantDays,
      total: kept.length,
      shown: Math.min(limit, kept.length),
      rows: sorted.slice(0, limit),
      byCaller: aggregateUsage(kept),
      byModel: aggregateByModel(kept),
      availableDays: await availableDays(),
    }
  }

  async function addKey({ name, group, enabled }: any) {
    const n = String(name ?? "").trim()
    const g = String(group ?? "").trim()
    if (!n) throw new CallerAdminError(400, "名字不能为空")
    const store = await readStore()
    if (!store.groups.some((x: any) => x.name === g)) throw new CallerAdminError(400, `分组 ${g} 不存在`)
    const secret = mintKey()
    const entry = {
      id: `k_${randomBytes(3).toString("hex")}`,
      name: n,
      group: g,
      sha256: sha256(secret),
      enabled: typeof enabled === "boolean" ? enabled : true,
      createdAt: new Date().toISOString(),
    }
    store.keys.push(entry)
    await writeStore(store)
    logger?.info?.(`[callers] 新增调用方 ${entry.id}（${n} / ${g}）`)
    return { key: entry.id, secret, group: g }
  }

  async function updateKey({ id, name, group, enabled }: any) {
    const keyId = String(id ?? "")
    const store = await readStore()
    const entry = store.keys.find((k: any) => k.id === keyId)
    if (!entry) throw new CallerAdminError(404, `key ${keyId} 不存在`)
    if (typeof name === "string" && name.trim()) entry.name = name.trim()
    if (typeof group === "string" && group) {
      if (!store.groups.some((x: any) => x.name === group)) throw new CallerAdminError(400, `分组 ${group} 不存在`)
      entry.group = group
    }
    if (typeof enabled === "boolean") entry.enabled = enabled
    await writeStore(store)
    return { ok: true, key: publicKey(entry) }
  }

  async function removeKey(id: string) {
    const keyId = String(id ?? "")
    const store = await readStore()
    const before = store.keys.length
    store.keys = store.keys.filter((k: any) => k.id !== keyId)
    if (store.keys.length === before) throw new CallerAdminError(404, `key ${keyId} 不存在`)
    await writeStore(store)
    logger?.info?.(`[callers] 删除调用方 ${keyId}`)
    return { ok: true }
  }

  async function saveGroup({ name, desc, allow }: any) {
    const n = String(name ?? "").trim()
    if (!n) throw new CallerAdminError(400, "分组名不能为空")
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(n)) throw new CallerAdminError(400, "分组名只能用字母数字和 _ . -，最长 40")
    const store = await readStore()
    const existing = store.groups.find((g: any) => g.name === n)
    const allowList = normalizeAllow(allow)
    if (!allowList.length) throw new CallerAdminError(400, "白名单不能为空（全放行请填 *）")
    if (existing) {
      existing.desc = String(desc ?? existing.desc ?? "")
      existing.allow = allowList
    } else {
      store.groups.push({ name: n, desc: String(desc ?? ""), allow: allowList })
    }
    await writeStore(store)
    logger?.info?.(`[callers] 保存分组 ${n}（allow=${allowList.length} 条）`)
    return { ok: true }
  }

  async function removeGroup(name: string) {
    const n = String(name ?? "")
    const store = await readStore()
    const users = store.keys.filter((k: any) => k.group === n).map((k: any) => k.name || k.id)
    if (users.length)
      throw new CallerAdminError(
        400,
        `分组 ${n} 仍被 ${users.length} 把 key 使用（${users.join("、")}），先改组或删掉它们`,
      )
    const before = store.groups.length
    store.groups = store.groups.filter((g: any) => g.name !== n)
    if (store.groups.length === before) throw new CallerAdminError(404, `分组 ${n} 不存在`)
    await writeStore(store)
    return { ok: true }
  }

  return { state, records, addKey, updateKey, removeKey, saveGroup, removeGroup, storePath }
}

export type CallersService = ReturnType<typeof createCallersService>
