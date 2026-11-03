/**
 * caller-gate.js — 调用方 Key / 分组 / 模型白名单
 *
 * 目的：一个 key 一个人，key 绑定一个分组，分组决定「能调哪些模型」，
 * 同时把每次调用的 caller / 模型 / 时间 / 用量记成 JSONL。
 *
 * 设计约束（为什么这么写）：
 * 1. **旁挂，不改上游**。判定在 `proxyToGateway` 之前，命中后把调用方的 key
 *    换成上游真 key 再转发。上游插件照旧只认自己那把，升级上游不受影响。
 * 2. **默认关闭**。`data/caller-keys.json` 不存在 = 闸门不生效，行为与改造前
 *    完全一致。要开就显式建这个文件，回滚 = 删文件 + 重启。
 * 3. **aggregate 必须单独授权**。`aggregate/*` 与 `jet-hub-auto/*` 会按额度
 *    临期自动挑渠道，等于绕过「只准用某某渠道」的限制。所以只要白名单不是
 *    `*`，这两类默认拒绝，除非显式写进 allow。
 * 4. **key 不落明文**。存 sha256 hex，比对用 timingSafeEqual。展示时只给前
 *    后各 4 位。
 */

import { createHash, timingSafeEqual } from "node:crypto"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Readable, Transform } from "node:stream"

/** 请求体上限。与 nginx 的 client_max_body_size 32m 对齐。 */
const BODY_CAP = 32 * 1024 * 1024

/**
 * 需要取 `model` 字段做白名单判定的路径。其余路径只做鉴权。
 *
 * 上游新增任何需要看 model 的路由都必须同步加入本集合，否则该路由的白名单判定失效
 * （只做鉴权、不比对 groups[].allow）。
 */
const MODEL_PATHS = new Set(["/v1/chat/completions", "/v1/completions", "/v1/responses", "/v1/embeddings"])

/** 走聚合路由的前缀：白名单不是 `*` 时必须显式授权。 */
const AGGREGATE_PREFIXES = ["aggregate/*", "jet-hub-auto/*"]

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex")

function hexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
  } catch {
    return false
  }
}

/** `provider/*` / `provider/model` / `*` → 正则。只允许 `*`，不引入其它通配语义。 */
function patternToRegExp(pattern) {
  const escaped = pattern
    .trim()
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${escaped}$`)
}

/**
 * 把分组编译成判定函数。
 * @returns {(model: string) => { allowed: boolean, reason?: string }}
 */
function compileGroup(group) {
  const allow = Array.isArray(group.allow) ? group.allow.filter((p) => typeof p === "string" && p.trim()) : []
  const deny = Array.isArray(group.deny) ? group.deny.filter((p) => typeof p === "string" && p.trim()) : []
  const allowAll = allow.includes("*")

  const allowRes = allow.map(patternToRegExp)
  const denyRes = deny.map(patternToRegExp)
  const aggregateRes = AGGREGATE_PREFIXES.map(patternToRegExp)

  return (model) => {
    if (typeof model !== "string" || !model) return { allowed: false, reason: "请求里没有 model 字段" }

    if (denyRes.some((re) => re.test(model))) return { allowed: false, reason: `模型 ${model} 在该分组的 deny 名单内` }

    if (!allowAll) {
      const isAggregate = aggregateRes.some((re) => re.test(model))
      if (isAggregate) {
        const explicitlyAllowed = allowRes.some((re) => re.test(model))
        if (!explicitlyAllowed) {
          return {
            allowed: false,
            reason: `${model} 属于聚合路由（会跨渠道选号），白名单不是 * 时必须显式列出才能使用`,
          }
        }
      }
      if (!allowRes.some((re) => re.test(model))) {
        return { allowed: false, reason: `模型 ${model} 不在该分组的白名单内` }
      }
    }
    return { allowed: true }
  }
}

function readBodyCapped(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    request.on("data", (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > BODY_CAP) {
        settled = true
        request.destroy()
        reject(Object.assign(new Error("request body too large"), { code: "E_TOO_LARGE" }))
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks))
      }
    })
    request.on("error", (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  response.end(body)
}

export function createCallerGate(options = {}) {
  const home = options.home
  const logger = options.logger ?? console
  const storePath = join(home, "caller-keys.json")
  const logDir = join(home, "caller-usage")

  let cached = null
  let cachedSig = ""
  // 文件不存在（闸门关闭）时的负缓存到期时刻：期内不再 statSync，
  // 避免每个 /v1 请求都白做一次系统调用（闸门默认关闭是常态）。
  let missingUntil = 0

  // ── 模型关闭表（disabledModels / providerClosed）的只读镜像 ──────────────────
  //
  // 为什么要在闸门里再读一份上游的 state.json：
  //   上游网关（dsh-providers-hub）是**刻意**把「关闭模型」实现成「从 /v1/models
  //   隐藏」而不是「拒绝调用」——见 lib/openai-gateway/model-errors.js 文件头注释，
  //   OpenAI 网关设计文档要求「隐藏模型不出现在 /v1/models，但显式请求仍交给 DSH
  //   路由处理」（因为有些渠道支持目录之外的新模型）。
  //   但本网关的用户语义是「关掉 = 谁都调不到」，所以拦截只能由我们这层做。
  //
  // 判据与上游**逐字对齐**，不自创语义：
  //   - account-pool.js:702 disabledModelsFor(provider) → 键存在且值为 true 即关闭
  //   - account-pool.js:743 providerClosedFor(provider) → 值为 true 即整渠道关闭
  //
  // 缓存策略：按 mtime 失效（开关操作会原子重写 state.json，mtime 必变）。
  // 读不到文件时**返回空表**（放行），而不是拦住——闸门是旁挂组件，不能因为
  // 上游存储暂时不可读就把整条链路打死。
  const statePath = join(home, "jet-hub", "state.json")
  let stateCache = { at: "", disabled: new Map(), closed: null }

  function loadDisabledState() {
    let stat
    try {
      stat = statSync(statePath)
    } catch {
      stateCache = { at: "", disabled: new Map(), closed: null }
      return stateCache
    }

    // 缓存键不能只看 mtimeMs：管理面写盘是 temp + rename，落在**同一毫秒**内时
    // mtimeMs 完全相同，于是「刚关掉」/「刚打开」的变更会被旧缓存盖住 ——
    // 表现为开关点了没反应，或者测试里连续 seed() 后判定错乱（实测踩到）。
    // 加上 size（内容变化基本必变）与 ino（rename 换 inode）后，同毫秒重写也能区分。
    const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`
    if (key === stateCache.at && stateCache.closed) return stateCache

    let parsed
    try {
      parsed = JSON.parse(readFileSync(statePath, "utf8"))
    } catch (error) {
      logger?.warn?.(`[caller-gate] 读取 ${statePath} 失败，本次放行（不拦模型）：${String(error)}`)
      return { at: -1, disabled: new Map(), closed: null }
    }

    const disabled = new Map()
    const rawDisabled = parsed?.disabledModels
    if (rawDisabled && typeof rawDisabled === "object") {
      for (const [provider, perProvider] of Object.entries(rawDisabled)) {
        if (!perProvider || typeof perProvider !== "object") continue
        const ids = Object.keys(perProvider).filter((id) => perProvider[id] === true)
        if (ids.length > 0) disabled.set(provider, new Set(ids))
      }
    }

    const closed = new Set()
    const rawClosed = parsed?.providerClosed
    if (rawClosed && typeof rawClosed === "object") {
      for (const [provider, flag] of Object.entries(rawClosed)) {
        if (flag === true) closed.add(provider)
      }
    }

    stateCache = { at: key, disabled, closed }
    return stateCache
  }

  /**
   * 判定某个 `provider/model` 是否被管理面关掉。
   *
   * ⚠️ 模型 ID 是 `provider/model` 且 provider 名里**不含** `/`，所以按第一个
   * `/` 切分——与上游 `parseModelRoute`（messages.js:507）**同一口径**。
   * 不切分而用整体 id 去查黑名单会永远查不到（黑名单键是裸模型名）。
   *
   * @returns {{ blocked: boolean, reason?: string, provider?: string, model?: string }}
   */
  function checkDisabled(model) {
    if (typeof model !== "string" || !model) return { blocked: false }
    const slash = model.indexOf("/")
    if (slash <= 0 || slash === model.length - 1) return { blocked: false }
    const provider = model.slice(0, slash)
    const bare = model.slice(slash + 1)

    const state = loadDisabledState()
    if (!state.closed) return { blocked: false } // 存储不可读 = 不拦

    if (state.closed.has(provider)) {
      return { blocked: true, reason: `渠道 ${provider} 已被整体关闭`, provider, model: bare }
    }
    const ids = state.disabled.get(provider)
    if (ids && ids.has(bare)) {
      return { blocked: true, reason: `模型 ${bare} 在渠道 ${provider} 上已被关闭`, provider, model: bare }
    }
    return { blocked: false, provider, model: bare }
  }

  function loadStore() {
    if (Date.now() < missingUntil) return null
    let stat
    try {
      stat = statSync(storePath)
    } catch {
      cached = null
      cachedSig = ""
      missingUntil = Date.now() + 2000
      return null
    }
    missingUntil = 0
    const sig = stat.mtimeMs + ":" + stat.size + ":" + stat.ino
    if (cachedSig === sig && cached) return cached

    let parsed
    try {
      parsed = JSON.parse(readFileSync(storePath, "utf8"))
    } catch (error) {
      // 文件坏了不能静默放行，也不能把服务打死：保持上一次可用状态。
      logger?.warn?.(`[caller-gate] 读取 ${storePath} 失败，沿用上一次配置：${String(error)}`)
      return cached
    }

    const groups = new Map()
    for (const group of Array.isArray(parsed.groups) ? parsed.groups : []) {
      if (!group || typeof group.name !== "string" || !group.name) continue
      groups.set(group.name, { ...group, match: compileGroup(group) })
    }

    const keys = new Map()
    const byDigest = new Map()
    for (const key of Array.isArray(parsed.keys) ? parsed.keys : []) {
      if (!key || typeof key !== "object") continue
      const digest = key.sha256 ?? (key.key ? sha256(key.key) : null)
      if (!digest) continue
      const group = groups.get(key.group)
      const entry = {
        id: key.id ?? digest.slice(0, 12),
        name: key.name ?? key.id ?? "unnamed",
        group: key.group,
        enabled: key.enabled !== false,
        digest,
        match: group ? group.match : null,
        groupMissing: !group,
      }
      keys.set(entry.id, entry)
      byDigest.set(digest, entry)
      if (!group) logger?.warn?.(`[caller-gate] key ${entry.id} 指向不存在的分组 ${key.group}，一律拒绝`)
    }

    cached = { groups, keys, byDigest, raw: parsed }
    cachedSig = sig
    logger?.info?.(`[caller-gate] 已加载 ${keys.size} 把调用方 key / ${groups.size} 个分组`)
    return cached
  }

  /** 上游网关那把 key 永远当「主 key」，全权放行——留一条不会把自己锁在门外的路。 */
  function masterEntry() {
    const key = typeof options.upstreamKey === "function" ? options.upstreamKey() : null
    if (!key) return null
    return {
      master: true,
      entry: {
        id: "master",
        name: "上游网关主 key",
        group: "full",
        enabled: true,
        groupMissing: false,
        match: () => ({ allowed: true }),
      },
    }
  }

  function authenticate(request) {
    const store = loadStore()
    if (!store) return null // 闸门未启用
    const header = String(request.headers?.authorization ?? "")
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match) return { unknown: true }
    const digest = sha256(match[1].trim())

    const master = masterEntry()
    if (master && hexEqual(sha256(String(options.upstreamKey()).trim()), digest)) return master

    const hit = store.byDigest.get(digest)
    if (!hit || !hexEqual(hit.digest, digest)) return { unknown: true }
    if (!hit.enabled) return { disabled: true, entry: hit }
    return { entry: hit }
  }

  /**
   * 判定一次请求。
   * @returns {Promise<{ ok: boolean, status?: number, error?: object, body?: Buffer, entry?: object, unbuffered?: boolean }>}
   */
  async function inspect(request, url, method) {
    const auth = authenticate(request)
    if (!auth) return { ok: true, disabled: true }
    if (auth.unknown) {
      return {
        ok: false,
        status: 401,
        error: { message: "Invalid API key provided.", type: "invalid_request_error", code: "invalid_api_key" },
      }
    }
    if (auth.disabled) {
      return {
        ok: false,
        status: 403,
        error: { message: `API key ${auth.entry.id} 已被停用。`, type: "invalid_request_error", code: "key_disabled" },
      }
    }
    const entry = auth.entry

    if (entry.groupMissing) {
      return {
        ok: false,
        status: 403,
        error: {
          message: `API key ${entry.id} 绑定的分组不存在。`,
          type: "invalid_request_error",
          code: "group_missing",
        },
      }
    }

    const isPost = method !== "GET" && method !== "HEAD"
    if (!isPost || !MODEL_PATHS.has(url.pathname)) {
      // 不取 body 的路径：仅鉴权通过即放行（请求体仍按原样流式透传）。
      return { ok: true, entry, unbuffered: true }
    }

    let raw
    try {
      raw = await readBodyCapped(request)
    } catch (error) {
      if (error?.code === "E_TOO_LARGE") {
        return {
          ok: false,
          status: 413,
          error: {
            message: `请求体超过 ${BODY_CAP} 字节上限。`,
            type: "invalid_request_error",
            code: "payload_too_large",
          },
        }
      }
      return {
        ok: false,
        status: 400,
        error: { message: "读取请求体失败。", type: "invalid_request_error", code: "bad_request_body" },
      }
    }

    let parsed
    try {
      parsed = JSON.parse(raw.toString("utf8"))
    } catch {
      return {
        ok: false,
        status: 400,
        error: { message: "请求体不是合法 JSON。", type: "invalid_request_error", code: "invalid_json" },
      }
    }

    const verdict = entry.match(parsed?.model)
    if (!verdict.allowed) {
      return {
        ok: false,
        status: 403,
        error: {
          message: `API key ${entry.id}（${entry.name} / 分组 ${entry.group}）无权使用该模型：${verdict.reason}`,
          type: "invalid_request_error",
          code: "model_not_allowed",
        },
      }
    }

    // 管理面关掉的模型必须连显式调用一起拒掉。
    // 上游只做「从 /v1/models 隐藏」（见本文件上方 loadDisabledState 的注释），
    // 因此「关掉 = 调不了」这条产品语义只能由这一层兑现。
    // ⚠️ 放在白名单之后判定：白名单是「这个 key 能不能用」，关闭表是「这个模型
    //    在整台网关上还能不能用」，两者是叠加关系，不该混在一条错误里。
    const disabled = checkDisabled(parsed?.model)
    if (disabled.blocked) {
      return {
        ok: false,
        status: 403,
        error: {
          message: `${disabled.reason}，调用已被拒绝。需要恢复请在 /admin 的渠道面板里重新打开该模型。`,
          type: "invalid_request_error",
          code: "model_disabled",
        },
      }
    }

    return { ok: true, entry, body: raw, model: parsed?.model }
  }

  /** `/v1/models` 按分组过滤。只放行该 key 能真正调到的模型。 */
  function filterModels(payload, entry) {
    if (!entry || entry.groupMissing) return payload
    const data = Array.isArray(payload?.data) ? payload.data : null
    if (!data) return payload
    const kept = data.filter((item) => {
      const id = item?.id
      if (typeof id !== "string") return false
      if (entry.match(id).allowed) return true
      // 聚合路由本身不列进模型的视图里会让客户端看不到「自动」选项，
      // 但没授权又调不通，所以这里也不保留。
      return false
    })
    return { ...payload, data: kept }
  }

  // 异步写 + 串行队列：不阻塞事件循环，同时保证同一进程内写入有序、不交叉。
  // 返回 Promise，便于测试/调用方在需要时 await（服务热路径不 await）。
  let logChain = Promise.resolve()
  function log(entry) {
    const line = `${JSON.stringify(entry)}\n`
    logChain = logChain.then(async () => {
      try {
        await mkdir(logDir, { recursive: true })
        // 目录按人眼里的「今天」分文件；用 UTC 会让 UTC+8 的 00:00-08:00 记到前一天。
        const now = new Date()
        const day =
          String(now.getFullYear()) +
          "-" +
          String(now.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(now.getDate()).padStart(2, "0")
        await appendFile(join(logDir, `${day}.jsonl`), line, "utf8")
      } catch (error) {
        logger?.warn?.(`[caller-gate] 写用量日志失败：${String(error)}`)
      }
    })
    return logChain
  }

  /**
   * 响应流侧回调：边透传边解析用量，结束时写一条日志。不改变字节流本身。
   *
   * 两类响应分开处理，避免「正文里出现 usage/error 字样」被误判：
   * - 流式（SSE，ctx.stream=true）：按 `data:` 帧逐条 JSON.parse，只看**帧顶层**的
   *   `usage` 与 `error`。上游常是「HTTP 200 + 帧内 error」（限流/被拦），必须据此
   *   把这次请求记成失败，否则会冒充成功、污染用量与筛选。
   * - 非流式：整段 JSON 里窗口匹配 `"usage"`（纯数值对象，安全），状态沿用 HTTP 状态。
   */
  function tapStream(source, ctx) {
    // 闸门没开（没有 store）就直接把原流交回去，一个字节都不多碰。
    if (!loadStore()) return source
    const startedAt = Date.now()
    const isStream = Boolean(ctx.stream)
    let status = ctx.status ?? 200
    let usage = null
    let streamError = null
    let tail = "" // 非流式：窗口匹配用
    let frameBuf = "" // 流式：SSE 帧缓冲

    const takeUsage = (obj) => {
      if (obj && typeof obj === "object" && obj.usage && typeof obj.usage === "object") usage = obj.usage
    }

    // 非流式：从整段 JSON 文本里抓 `"usage":{...}`。usage 是纯数值对象，
    // 不含「字符串值里的花括号」，括号配平足够安全。
    const grabUsage = () => {
      const at = tail.lastIndexOf('"usage"')
      if (at < 0) return
      const start = tail.indexOf("{", at)
      if (start < 0) return
      let depth = 0
      for (let i = start; i < tail.length; i++) {
        const c = tail[i]
        if (c === "{") depth++
        else if (c === "}") {
          depth--
          if (depth === 0) {
            try {
              const o = JSON.parse(tail.slice(start, i + 1))
              if (o && typeof o === "object") usage = o
            } catch {
              /* 半截 JSON，忽略 */
            }
            return
          }
        }
      }
    }

    // 流式：只在凑够完整帧（出现空行）时才处理，避免每个 chunk 都 replace/split。
    const scanSse = (text) => {
      frameBuf += text
      if (frameBuf.indexOf("\n\n") < 0 && frameBuf.indexOf("\r\n\r\n") < 0) return
      const parts = frameBuf.replace(/\r\n/g, "\n").split("\n\n")
      frameBuf = parts.pop() // 末段可能不完整，留到下一块
      for (const ev of parts) {
        const data = ev
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (data === "" || data === "[DONE]") continue
        try {
          const obj = JSON.parse(data)
          takeUsage(obj)
          const err = obj && obj.error
          if (err && typeof err === "object" && (err.code || err.message)) streamError = err
        } catch {
          /* 非 JSON 帧，忽略 */
        }
      }
    }

    const tap = new Transform({
      transform(chunk, _enc, callback) {
        try {
          const text = chunk.toString("utf8")
          if (isStream) {
            scanSse(text)
          } else {
            tail += text
            if (tail.length > 262144) tail = tail.slice(-131072)
            grabUsage()
          }
        } catch {
          /* 扫描失败绝不影响转发 */
        }
        callback(null, chunk)
      },
      flush(callback) {
        // 末帧可能没有以空行收尾，补处理一次。
        if (isStream && frameBuf.trim() !== "") {
          try {
            scanSse("\n\n")
          } catch {
            /* ignore */
          }
        }
        const inTok = usage?.input_tokens ?? usage?.prompt_tokens ?? null
        const outTok = usage?.output_tokens ?? usage?.completion_tokens ?? null
        // 仅「流式 2xx 但帧内报 error」才改判失败；非流式沿用 HTTP 状态（上游本就会给正确码）。
        let finalStatus = status
        if (isStream && streamError && status >= 200 && status < 300) {
          const es = Number(streamError.status)
          finalStatus = Number.isFinite(es) && es >= 400 ? es : 502
        }
        log({
          ts: new Date().toISOString(),
          caller: ctx.callerId ?? null,
          name: ctx.callerName ?? null,
          group: ctx.callerGroup ?? null,
          model: ctx.model ?? null,
          path: ctx.path ?? null,
          status: finalStatus,
          error_code: streamError ? (streamError.code ?? null) : null,
          stream: Boolean(ctx.stream),
          ms: Date.now() - startedAt,
          in_tokens: inTok,
          out_tokens: outTok,
          total_tokens: usage?.total_tokens ?? (inTok != null && outTok != null ? inTok + outTok : null),
        })
        callback()
      },
    })

    // 关键：Transform 必须与源流接上，否则下游永远收不到字节（第一版漏了这行，
    // 表现为响应头到了、body 一个字节不来，客户端等到超时）。
    source.pipe(tap)
    return tap
  }

  /** 首次生成一份可用样例：一个 full 组 + 一条 key（需要用户填 key 值）。 */
  function scaffold() {
    const template = {
      version: 1,
      _comment:
        "groups[].allow / deny 支持 `*`、`provider/*`、完整模型名；aggregate/* 与 jet-hub-auto/* 只有当白名单不是 * 且显式列出时才可用。keys[].key 是明文（仅用于首次导入），保存后请换成 sha256。",
      groups: [
        { name: "full", desc: "全部模型", allow: ["*"] },
        {
          name: "basic",
          desc: "常规对话模型（不含聚合路由）",
          allow: ["codearts/*", "qodercn/gmodel", "qodercn/kmodel", "qodercn/kmodel_latest", "zcode/*"],
        },
        { name: "codearts-only", desc: "仅华为云码道", allow: ["codearts/*"] },
      ],
      keys: [],
    }
    writeFileSync(storePath, `${JSON.stringify(template, null, 2)}\n`, "utf8")
    return template
  }

  return {
    storePath,
    logDir,
    inspect,
    filterModels,
    log,
    tapStream,
    scaffold,
    reload: () => {
      cachedSig = ""
      missingUntil = 0
      stateCache = { at: "", disabled: new Map(), closed: null }
      return loadStore()
    },
    sendJson,
    Readable,
    /** server.js 反代前要用它把调用方的 key 换成上游真 key。 */
    upstreamKey: () => (typeof options.upstreamKey === "function" ? options.upstreamKey() : null),
    /** 供 /admin 与排查用：当前被关掉的模型/渠道（不含实现细节）。 */
    disabledSnapshot: () => {
      const state = loadDisabledState()
      const out = { providers: {}, closed: [] }
      if (!state.closed) return out
      for (const [provider, ids] of state.disabled.entries()) out.providers[provider] = Array.from(ids)
      out.closed = Array.from(state.closed)
      return out
    },
    /** 单点判定，给测试与未来的管理面复用。 */
    checkDisabled,
  }
}

export const _internal = { compileGroup, patternToRegExp, sha256 }
