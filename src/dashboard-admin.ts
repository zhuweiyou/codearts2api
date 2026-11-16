/**
 * 总览看板 —— 后端聚合 + UI 脚本挂载。
 *
 * 用户约束（2026-11-02）：
 *   1. 不要独立 URL：不在 /admin 之外另开页面。看板以模态框形式活在 /admin 里，
 *      由注入的「总览」按钮唤起。因此本文件不提供页面端点。
 *   2. 主题与原生一致：UI 层全部复用上游 .dim-jh-modal / .dim-jh-btn 类名与
 *      var(--dsw-alias-*, 原生回退值)，不自己发明配色。
 *
 * 数据全部读本机文件，不向上游发请求（余额除外，有 5 分钟缓存 + 单飞）。
 */

import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

export const API_PATH = "/admin/dashboard/api"

/** 余额缓存时长：5 分钟，避免多个浏览器窗口同时打上游。 */
const BALANCE_TTL_MS = 5 * 60 * 1000
const PERMANENT_BALANCE_PROVIDERS = new Set(["cline", "codely"])
const PERMANENT_PACKAGE_PROVIDERS = new Set(["loomy", "magicrew", "magicrewintl"])

/**
 * 读一个 JSON 文件；不存在或坏掉都返回 `undefined`（看板不该因为少一个文件 500）。
 *
 * ⚠️ 异步读：看板一次快照要读 5~6 个文件（含当日 300KB+ 的用量 JSONL），
 *    同步读会让整个进程在这段时间里停止响应 `/v1` 流式请求。
 */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

async function readJsonl(file) {
  let text
  try {
    text = await readFile(file, "utf8")
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
}

/** 按 UTC+8 取日期字符串。 */
function utc8Date(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function errorText(error) {
  const msg = error && error.message ? error.message : String(error)
  if (/unsupported provider/i.test(msg)) return "该渠道不支持余额查询"
  return msg
}

function normalizeExpiry(v) {
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v)
  return t > 0 && t <= 8.64e15 ? t : undefined
}

/**
 * 创建聚合器。
 *
 * 参数是 dataDir，它本身就是 .../data（即 host.home）。
 * 不要在它下面再 join("data")，否则读到不存在的 data/data/*，
 * 症状是接口 200 但所有区块空白 —— 极难排查。
 *
 * @param {{dataDir: string, rpc: (method: string, payload?: object) => Promise<any>, gateway?: () => object, logger?: object}} deps
 */
export function createDashboard(deps) {
  const dataDir = deps.dataDir
  const jetHub = join(dataDir, "jet-hub")
  const usageDir = join(dataDir, "caller-usage")

  let balanceCache = { at: 0, value: undefined }
  let balanceInflight = null

  /** 余额：逐渠道串行调用 credits.balances（传数组会报 unsupported provider: undefined）。 */
  async function balances(providers, fresh) {
    if (!fresh && balanceCache.value !== undefined && Date.now() - balanceCache.at < BALANCE_TTL_MS) {
      return { value: balanceCache.value, cachedAt: balanceCache.at }
    }
    if (balanceInflight) {
      const value = await balanceInflight
      return { value, cachedAt: balanceCache.at }
    }
    balanceInflight = (async () => {
      const out = {}
      for (const provider of providers) {
        try {
          out[provider] = await deps.rpc("credits.balances", { provider })
        } catch (error) {
          out[provider] = { error: errorText(error) }
        }
      }
      balanceCache = { at: Date.now(), value: out }
      return out
    })()
    try {
      const value = await balanceInflight
      return { value, cachedAt: balanceCache.at }
    } finally {
      balanceInflight = null
    }
  }

  function accountsOf(state) {
    const raw = state && state.accounts
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : []
    return list.map((a) => {
      const expiresAt = normalizeExpiry(a.expiresAt)
      const nowMs = Date.now()
      const msLeft = expiresAt === undefined ? undefined : expiresAt - nowMs
      /* 天数是「向下取整」的粗粒度，不到 24 小时一律显示 0 天，红点 + 「0 天」
         看不出是「1 小时后过期」还是「已经过期」。2026-11-02 实测 codearts 只剩
         1.13 小时、minimax 只剩 16.7 分钟，面板都显示「0 天」。小于 2 天时改成
         显示小时/分钟，让人能判断「要不要现在处理续期」。 */
      const daysLeft = msLeft === undefined ? undefined : Math.floor(msLeft / 86400000)
      let expiryText
      if (msLeft === undefined) expiryText = undefined
      else if (msLeft <= 0) expiryText = "已过期"
      else if (msLeft < 2 * 86400000) {
        const hours = Math.floor(msLeft / 3600000)
        if (hours >= 1) expiryText = hours + " 小时"
        else expiryText = Math.max(1, Math.floor(msLeft / 60000)) + " 分钟"
      } else expiryText = daysLeft + " 天"
      /* modelRateLimits 是 { modelId: 重置时间戳(ms) }，而**上游从不清理过期键**
         （实测 trae-9cc67abb 只剩 kimi-k3.1-pro=1793311127621 已过期、qodercn 残留
         7 条里只有 1 条还在有效期内）。按 Object.keys().length 直接计数会把过期
         残留算成「N 模型限流」，面板就会长期挂着一条假的告警 —— 用户 2026-11-02
         报「显示 1 模型限流」，实际当下是正常的。所以必须先按 now 过滤。 */
      const rl = a.modelRateLimits
      const now = Date.now()
      const rlItems =
        rl && typeof rl === "object"
          ? Object.keys(rl)
              .map((model) => ({ model, until: Number(rl[model]) }))
              .filter((x) => Number.isFinite(x.until) && x.until > now)
          : []
      const rateLimited = rlItems.length
      const rateLimitedModels = rlItems
        .sort((x, y) => x.until - y.until)
        .map(
          (x) =>
            x.model +
            " · 到 " +
            new Date(x.until).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
        )
        .join("、")
      return {
        id: a.id,
        provider: a.provider,
        nickname: a.nickname,
        enabled: a.enabled !== false,
        refreshable: a.refreshable === true,
        createdAt: a.createdAt,
        expiresAt,
        daysLeft,
        expiryText,
        credential: a.credentialRef ? "已配置" : "未配置",
        rateLimited,
        rateLimitedModels,
      }
    })
  }

  async function collectUsage(today) {
    let files
    try {
      files = (await readdir(usageDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    } catch {
      files = []
    }

    const byDate = new Map()
    for (const f of files) {
      const date = f.slice(0, 10)
      const agg = { date, requests: 0, ok: 0, errors: 0, inTokens: 0, outTokens: 0, models: {}, callers: {} }
      for (const r of await readJsonl(join(usageDir, f))) {
        agg.requests += 1
        if ((r.status === undefined ? 200 : r.status) < 400) agg.ok += 1
        else agg.errors += 1
        // in_tokens 可能为 null，必须 or 0
        agg.inTokens += r.in_tokens || 0
        agg.outTokens += r.out_tokens || 0
        const model = String(r.model || "?")
        agg.models[model] = (agg.models[model] || 0) + 1
        const caller = String(r.caller || "?")
        agg.callers[caller] = (agg.callers[caller] || 0) + 1
      }
      byDate.set(date, agg)
    }

    // 连续 14 天窗口：缺日志的天补 empty。否则前端会把仅有的几根柱子等分铺满整宽，
    // 视觉上等于「这几天天天爆量」，缺失的天完全看不见。
    const days = []
    const anchor = new Date(today + "T00:00:00+08:00").getTime()
    for (let i = 13; i >= 0; i -= 1) {
      // 必须走 utc8Date，不能 toISOString()：UTC+8 的 00:00-08:00 会退到前一天，
      // 导致「今天」这一格整个消失（症状：今日用量卡有数、趋势图最后一格空白）。
      const key = utc8Date(new Date(anchor - i * 86400000))
      const hit = byDate.get(key)
      days.push(
        hit || {
          date: key,
          requests: 0,
          ok: 0,
          errors: 0,
          inTokens: 0,
          outTokens: 0,
          models: {},
          callers: {},
          empty: true,
        },
      )
    }

    const t = byDate.get(today) || {
      date: today,
      requests: 0,
      ok: 0,
      errors: 0,
      inTokens: 0,
      outTokens: 0,
      models: {},
      callers: {},
    }
    return { days, today: t }
  }

  async function collectLedger() {
    const doc = await readJson(join(jetHub, "token-ledger.json"))
    if (!doc || !doc.days) return []
    const out = []
    for (const [date, entries] of Object.entries(doc.days)) {
      if (!entries || typeof entries !== "object") continue
      let cacheRead = 0
      let ttftSum = 0
      let ttftCount = 0
      let requests = 0
      for (const v of Object.values(entries)) {
        if (!v || typeof v !== "object") continue
        cacheRead += v.cacheReadTokens || 0
        requests += v.requests || 0
        if (v.ttftCount && v.ttftSumMs) {
          ttftSum += v.ttftSumMs
          ttftCount += v.ttftCount
        }
      }
      out.push({
        date,
        requests,
        cacheRead,
        ttftAvgMs: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : 0,
      })
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1))
  }

  /**
   * 余额读数 → 积分收支账本。
   *
   * ⚠️ 上游没有「积分流水」接口（`credits.balances` 只回当前包的 total / used / remaining），
   *    所以这里的「收入 = 包的总量」「支出 = 包的已用量」「结余 = 剩余」是**账本级**口径，
   *    不是逐笔流水。不要伪造逐笔记录。
   *
   * ⚠️ 单位必须分开汇总：实测同一时刻存在 credits（qodercn/trae/minimax）、credit（codearts）、
   *    token（zcode）、通道（opencode）四种 unit，跨单位相加是错的。
   */
  function collectCredits(balanceMap) {
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
    const packages = []
    const byUnit = new Map()
    const byProvider = new Map()
    const buckets = { d7: [], d30: [], later: [], never: [], expired: [], undatedExpiring: [] }
    const now = Date.now()

    for (const [provider, pack] of Object.entries(balanceMap || {})) {
      if (!pack || pack.error) continue
      const accs = Array.isArray(pack.accounts) ? pack.accounts : []
      for (const acc of accs) {
        const bal = acc && acc.balance
        if (!bal) continue
        for (const p of Array.isArray(bal.packages) ? bal.packages : []) {
          const total = num(p.total)
          const remaining = num(p.remaining)
          // used 缺省时按 total - remaining 反推（qodercn 的「套餐额度」就是这种形态）
          const used = p.used === undefined || p.used === null ? Math.max(0, total - remaining) : num(p.used)
          const unit = String(p.unit || "credit")
          // 扣费截止和额度重置是独立的时间。兼容只上报 expiredTime 的渠道。
          const deductionEnd = num(p.deductionEndTime)
          const reportedEnd = deductionEnd > 0 && deductionEnd <= 8.64e15 ? deductionEnd : Date.parse(p.expiredTime)
          const endAt = Number.isFinite(reportedEnd) ? reportedEnd : null
          const resetAt = provider === "gemini" || provider === "accio" ? Date.parse(p.cycleEndTime) : NaN
          // CodeBuddy 的失效状态有时只有标记，没有时间。其他渠道的 inactive 也可能是待生效。
          const buddyPackage = provider === "buddy" || provider === "workbuddy"
          const expired = (endAt !== null && endAt <= now) || (buddyPackage && p.active === false)
          const active = p.active !== false && !expired
          const expiringRemaining =
            endAt === null && active ? Math.max(0, Math.min(remaining, num(p.expiringRemaining))) : 0
          const expiryNote = typeof p.expiryNote === "string" ? p.expiryNote.trim() : ""
          // 余额型渠道保留既有口径。有定时批次的渠道只匹配明确标注的长期余额。
          const permanent =
            !p.deductionEndTime &&
            !p.expiredTime &&
            !p.cycleEndTime &&
            !expiryNote &&
            expiringRemaining === 0 &&
            p.expiryUnknown !== true &&
            (PERMANENT_BALANCE_PROVIDERS.has(provider) ||
              (PERMANENT_PACKAGE_PROVIDERS.has(provider) && (p.name === "永久积分" || p.name === "长期积分")))
          const row = {
            provider,
            accountId: acc.accountId,
            nickname: acc.nickname,
            name: String(p.name || "（未命名包）"),
            unit,
            total,
            used,
            remaining,
            active,
            expired,
            pct: total > 0 ? (used / total) * 100 : 0,
            endAt,
            resetAt: Number.isFinite(resetAt) ? resetAt : null,
            expiredTime: p.expiredTime || "",
            expiryNote,
            permanent,
            expiringRemaining,
            // 魔搭返回整笔余额，日奖励的到期时间只用于该行的说明。
            ...(provider === "modelscope" && Number.isFinite(bal.dailyGrantExpiresAt) && bal.dailyGrantExpiresAt > 0
              ? { dailyGrantExpiresAt: bal.dailyGrantExpiresAt }
              : {}),
          }
          packages.push(row)

          const u = byUnit.get(unit) || { unit, total: 0, used: 0, remaining: 0, packs: 0 }
          if (active) {
            u.total += total
            u.used += used
            u.remaining += remaining
          }
          u.packs += 1
          byUnit.set(unit, u)

          const pk = provider + "|" + unit
          const pv = byProvider.get(pk) || {
            provider,
            unit,
            total: 0,
            used: 0,
            remaining: 0,
            packs: 0,
            accounts: new Set(),
          }
          if (active) {
            pv.total += total
            pv.used += used
            pv.remaining += remaining
          }
          pv.packs += 1
          if (acc.accountId) pv.accounts.add(acc.accountId)
          byProvider.set(pk, pv)

          // 已失效的账面余额单列。临期预警只统计仍可用的余额。
          if (remaining <= 0) continue
          if (expired) buckets.expired.push(row)
          if (!active) continue
          if (endAt === null) {
            if (expiringRemaining > 0) buckets.undatedExpiring.push(row)
            else if (permanent) buckets.never.push(row)
          } else {
            const left = endAt - now
            if (left <= 7 * 86400_000) buckets.d7.push(row)
            else if (left <= 30 * 86400_000) buckets.d30.push(row)
            else buckets.later.push(row)
          }
        }
      }
    }

    const sumRemaining = (list) => list.reduce((s, r) => s + r.remaining, 0)
    const sortByRemaining = (list) => list.slice().sort((a, b) => b.remaining - a.remaining)

    return {
      packages: packages.sort((a, b) => b.remaining - a.remaining || (a.provider < b.provider ? -1 : 1)),
      units: [...byUnit.values()].sort((a, b) => b.remaining - a.remaining),
      providers: [...byProvider.values()]
        .map((v) => ({ ...v, accounts: [...v.accounts] }))
        .sort((a, b) => (a.provider < b.provider ? -1 : 1)),
      expiry: {
        d7: sortByRemaining(buckets.d7),
        d30: sortByRemaining(buckets.d30),
        later: sortByRemaining(buckets.later),
        never: sortByRemaining(buckets.never),
        expired: sortByRemaining(buckets.expired),
        undatedExpiring: buckets.undatedExpiring.sort((a, b) => b.expiringRemaining - a.expiringRemaining),
        d7Remaining: sumRemaining(buckets.d7),
        // ⚠️ 必须用 concat：数组之间用 + 会变成字符串拼接，sumRemaining 里 list.reduce 直接抛
        //    TypeError: list.reduce is not a function
        d30Remaining: sumRemaining(buckets.d30.concat(buckets.d7)),
        expiredRemaining: sumRemaining(buckets.expired),
      },
    }
  }

  /**
   * 自动签到状态（看板口径）。
   *
   * ⚠️ `data/jet-hub/auto-checkin.json` 里只有 enabled / lastDate / lastResult / channels，
   *    **没有 ranToday** —— ranToday 是 RPC `usage.autoCheckin` 现算的（doc.lastDate === today()）。
   *    直接透传文件会让前端 `c.ranToday === true` 恒为 false，看板永远显示「今日签到 未完成」，
   *    2026-11-02 用户实测报「为什么显示今日签到未完成，最近 2026-11-02」。这里自己判一次。
   */
  async function checkinOf() {
    const doc = await readJson(join(jetHub, "auto-checkin.json"))
    if (!doc) return null
    const today = utc8Date()
    const lastDate = typeof doc.lastDate === "string" ? doc.lastDate : ""
    let lagDays = null
    if (/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) {
      // 用 UTC+8 零点换算，避免本地时区把天数算错一天
      lagDays = Math.round(
        (Date.parse(today + "T00:00:00+08:00") - Date.parse(lastDate + "T00:00:00+08:00")) / 86400000,
      )
    }
    return { ...doc, today, ranToday: lastDate === today, lagDays }
  }
  async function snapshot({ fresh = false } = {}) {
    const today = utc8Date()
    const state = (await readJson(join(jetHub, "state.json"))) || {}
    const accounts = accountsOf(state)
    const providers = [...new Set(accounts.map((a) => a.provider).filter(Boolean))]
    // ⚠️ 解构出的变量不能叫 balances —— 与上面的 balances() 函数同名会在本作用域
    //    形成 TDZ，调用时抛 ReferenceError: Cannot access 'balances' before initialization。
    const { value: balanceMap, cachedAt } = await balances(providers, fresh)

    const callers = await readJson(join(dataDir, "caller-keys.json"))

    // 模型清单：优先读 model-catalog.json（若有），否则回落 gateway.getEnabled 的 models。
    // ⚠️ 该网关的 data/jet-hub 下**没有** model-catalog.json，所以不能只靠文件。
    let models = []
    const catalog = await readJson(join(jetHub, "model-catalog.json"))
    if (Array.isArray(catalog)) models = catalog
    else if (Array.isArray(catalog?.models)) models = catalog.models
    if (models.length === 0 && typeof deps.rpc === "function") {
      try {
        const gw = await deps.rpc("gateway.getEnabled", {})
        if (Array.isArray(gw?.models)) models = gw.models
      } catch {
        /* 拿不到就留空，前端显示「清单为空」 */
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      // 同步/异步都支持：上游 readGatewayState 是 async，统一 await 最省事。
      gateway: deps.gateway ? await deps.gateway() : {},
      accounts,
      balances: balanceMap,
      balancesCachedAt: cachedAt,
      models,
      // ⚠️ auto-checkin.json 里**没有** ranToday 字段（那是 RPC usage.autoCheckin 现算的），
      //    直接透传会让前端 `c.ranToday === true` 恒为 false，显示「今日签到 未完成」——
      //    2026-11-02 用户实测报「为什么显示今日签到未完成，最近 2026-11-02」。
      //    这里按 UTC+8 日键自己判一次。
      checkin: await checkinOf(),
      callers: {
        keys: Array.isArray(callers?.keys) ? callers.keys.length : 0,
        groups: Array.isArray(callers?.groups) ? callers.groups.length : 0,
      },
      usage: await collectUsage(today),
      ledger: await collectLedger(),
      // 积分收支（账本级，不是逐笔流水 —— 上游没有流水接口）
      credits: collectCredits(balanceMap),
    }
  }

  return { snapshot }
}

/**
 * HTTP 挂载：handle(request, response, url) -> boolean，与 callerAdmin 同签名。
 * 只暴露两个端点，没有页面端点（看板不是独立 URL）。
 */
export function createDashboardAdmin(options) {
  const dashboard = createDashboard(options)
  return {
    async handle(request, response, url) {
      if (url.pathname === API_PATH) {
        if (request.method !== "GET") {
          response.writeHead(405, { "content-type": "application/json; charset=utf-8" })
          response.end(JSON.stringify({ error: "Method Not Allowed" }))
          return true
        }
        try {
          const fresh = url.searchParams.get("fresh") === "1"
          const data = await dashboard.snapshot({ fresh })
          response.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          })
          response.end(JSON.stringify(data))
        } catch (error) {
          options.logger?.error?.("[dashboard] snapshot failed: " + String(error))
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
          response.end(JSON.stringify({ error: String(error) }))
        }
        return true
      }

      return false
    },
  }
}
