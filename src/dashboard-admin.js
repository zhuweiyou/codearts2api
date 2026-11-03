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
export const UI_PATH = "/admin/dashboard-ui.js"

/** 余额缓存时长：5 分钟，避免多个浏览器窗口同时打上游。 */
const BALANCE_TTL_MS = 5 * 60 * 1000

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
  if (v === undefined || v === null || v === "" || v === 0) return undefined
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
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
    const buckets = { d7: [], d30: [], later: [], never: [], expired: [] }
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
          const row = {
            provider,
            accountId: acc.accountId,
            nickname: acc.nickname,
            name: String(p.name || "（未命名包）"),
            unit,
            total,
            used,
            remaining,
            active: p.active !== false,
            pct: total > 0 ? (used / total) * 100 : 0,
            // 到期时刻：优先 deductionEndTime（各渠道统一的「何时作废」语义），
            // 其次解析 expiredTime（codearts 系只给 ISO 串）。
            // ⚠️ 无到期时间必须是 null 而不是 NaN：NaN 经 JSON 序列化成 null，
            //    前端再 Number.isNaN(null) 为 false，会渲染成 1970-01-01（实测踩过）。
            //    这里统一成 null，前端用 endAt === null 判「永久/无期限」。
            endAt:
              typeof p.deductionEndTime === "number" && p.deductionEndTime > 0
                ? p.deductionEndTime
                : p.expiredTime
                  ? Number.isNaN(Date.parse(p.expiredTime))
                    ? null
                    : Date.parse(p.expiredTime)
                  : null,
            expiredTime: p.expiredTime || "",
          }
          packages.push(row)

          const u = byUnit.get(unit) || { unit, total: 0, used: 0, remaining: 0, packs: 0 }
          u.total += total
          u.used += used
          u.remaining += remaining
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
          pv.total += total
          pv.used += used
          pv.remaining += remaining
          pv.packs += 1
          if (acc.accountId) pv.accounts.add(acc.accountId)
          byProvider.set(pk, pv)

          // 到期分档只看还有余额的包（空包过期与否都不影响可用性）
          if (remaining <= 0) continue
          if (row.endAt === null) buckets.never.push(row)
          else {
            const left = row.endAt - now
            if (left <= 0) buckets.expired.push(row)
            else if (left <= 7 * 86400_000) buckets.d7.push(row)
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

      if (url.pathname === UI_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" })
          response.end("Method Not Allowed")
          return true
        }
        const body = Buffer.from(UI_SRC, "utf8")
        response.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "content-length": String(body.length),
          "cache-control": "no-store",
        })
        response.end(request.method === "HEAD" ? undefined : body)
        return true
      }

      return false
    },
  }
}

/** UI 脚本源码，通过 UI_PATH 提供给浏览器。 */
export const UI_SRC = String.raw`
(function () {
  "use strict";
  if (window.__c2dDashboardUI) return;
  window.__c2dDashboardUI = true;

  const API = "/admin/dashboard/api";
  const REFRESH_MS = 30000;
  let timer = null;
  let overlay = null;
  // 上一次成功的快照：再次打开弹窗时先画它（不必等一次网络往返）。
  let lastSnapshot = null;

  /* ── 工具 ─────────────────────────────────────────────────────────── */

  const esc = (s) =>
    String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmt = (n) => {
    if (n === undefined || n === null || Number.isNaN(n)) return "—";
    return Math.round(n).toLocaleString("zh-CN");
  };

  const fmtTokens = (n) => {
    if (!n) return "0";
    if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
    if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
    return fmt(n);
  };

  const ago = (iso) => {
    if (!iso) return "—";
    // ⚠️ 客户端时钟可能比服务器慢一两秒，直接算会渲染成「-1 秒前」（实测截图里出现过）。
    //    负数一律钳成「刚刚」。
    const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (sec < 5) return "刚刚";
    if (sec < 60) return sec + " 秒前";
    if (sec < 3600) return Math.round(sec / 60) + " 分钟前";
    if (sec < 86400) return Math.round(sec / 3600) + " 小时前";
    return Math.round(sec / 86400) + " 天前";
  };

  /* ── 样式：只补原生没有的那几个（指标卡、趋势条、进度条） ────────────
     颜色全部引用上游自己的 CSS 变量并给出与原生一致的缺省值，
     这样原生若哪天换成深色主题，看板会自动跟着变。 */
  function ensureStyle() {
    if (document.getElementById("c2d-style")) return;
    const st = document.createElement("style");
    st.id = "c2d-style";
    st.textContent = [
      /* ⚠️ 这里不要再写 overflow/max-height：外层的 .dim-jh-modalBody 本身就是唯一的滚动容器
         （上游 CSS 646 行 flex:1 1 auto + overflow-y:auto）。两处都滚就会出现两条并排竖滚动条 ——
         2026-11-02 用户实测报「总览有两个侧边滚动条」。 */
      ".c2d-body{display:flex;flex-direction:column;gap:18px}",
      ".c2d-section{margin:0}",
      ".c2d-sectionTitle{font-size:13px;font-weight:600;line-height:19.5px;margin:0 0 6px;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".c2d-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px}",
      ".c2d-card{border:1px solid var(--dsw-alias-border-default,#e5e5e5);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-3,#fff)}",
      ".c2d-card .k{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-card .v{font-size:20px;font-weight:600;line-height:1.25;margin-top:2px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".c2d-card .v .u{font-size:11.5px;font-weight:400;color:var(--dsw-alias-label-tertiary,#8f959e);margin-left:3px}",
      ".c2d-card .f{font-size:11px;line-height:16px;margin-top:3px;color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-card.ok .v{color:var(--dsw-alias-state-success-primary,#15803d)}",
      ".c2d-card.warn .v{color:var(--dsw-alias-state-warn-primary,#b45309)}",
      ".c2d-card.bad .v{color:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2d-card.brand .v{color:var(--dsw-alias-brand-primary,#1677ff)}",
      ".c2d-tbl{width:100%;border-collapse:collapse;font-size:11.5px}",
      ".c2d-tbl th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary,#8f959e);padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-default,#e5e5e5);white-space:nowrap}",
      ".c2d-tbl td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,#eef0f3);color:var(--dsw-alias-text-secondary,#4e5969);vertical-align:middle}",
      ".c2d-tbl tr:last-child td{border-bottom:0}",
      ".c2d-tbl .num{text-align:right;font-variant-numeric:tabular-nums}",
      ".c2d-ch{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".c2d-muted{color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-err{color:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2d-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:1px}",
      ".c2d-dot.ok{background:var(--dsw-alias-state-success-primary,#15803d)}",
      ".c2d-dot.warn{background:var(--dsw-alias-state-warn-primary,#b45309)}",
      ".c2d-dot.bad{background:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2d-dot.off{background:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-bar{height:4px;border-radius:2px;overflow:hidden;margin-top:3px;background:var(--dsw-alias-bg-layer-2,#f4f5f7)}",
      ".c2d-bar>i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-success-primary,#15803d)}",
      ".c2d-bar>i.warn{background:var(--dsw-alias-state-warn-primary,#b45309)}",
      ".c2d-bar>i.bad{background:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2d-bar>i.brand{background:var(--dsw-alias-brand-primary,#1677ff)}",
      ".c2d-two{display:grid;grid-template-columns:1fr 1fr;gap:16px}",
      ".c2d-trend{display:flex;align-items:flex-end;gap:3px;height:104px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-default,#e5e5e5);border-radius:8px;padding:8px 10px 6px;background:var(--dsw-alias-bg-layer-3,#fff)}",
      ".c2d-trend .col{flex:1;position:relative;height:100%;min-width:0}",
      ".c2d-trend .col i{position:absolute;left:0;right:0;bottom:0;display:block;min-height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-brand-primary,#1677ff);opacity:.82}",
      ".c2d-trend .col i.nodata{background:var(--dsw-alias-border-default,#e5e5e5);opacity:1;border-radius:1px}",
      ".c2d-trend .col:hover i{opacity:1}",
      ".c2d-axis{display:flex;gap:3px;margin-top:4px}",
      ".c2d-axis span{flex:1;text-align:center;font-size:10px;color:var(--dsw-alias-label-tertiary,#8f959e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".c2d-axis span.nodata{opacity:.4}",
      ".c2d-empty{padding:14px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#8f959e);border:1px dashed var(--dsw-alias-border-default,#e5e5e5);border-radius:8px}",
      ".c2d-pkg{min-width:132px}",
      ".c2d-pkgName{font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}",
      ".c2d-sub2{font-size:11.5px;font-weight:600;margin:10px 0 5px;color:var(--dsw-alias-label-secondary,#5f6672)}",
      ".c2d-scroll{max-height:212px;overflow:auto}",
      ".c2d-unit{font-size:11px;color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-chan{border:1px solid var(--dsw-alias-border-default,#e5e5e5);border-radius:8px;padding:9px 11px;margin:0 0 9px;background:var(--dsw-alias-bg-layer-3,#fff)}",
      ".c2d-chanHead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:5px}",
      ".c2d-ico{display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;flex:0 0 auto}",
      ".c2d-ico img{width:18px;height:18px;border-radius:4px;object-fit:contain}",
      ".c2d-chanName{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".c2d-chanCell{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap}",
      ".c2d-chanSum{font-size:11.5px;color:var(--dsw-alias-text-secondary,#4e5969);margin-left:auto;font-variant-numeric:tabular-nums}",
      ".c2d-accs{display:flex;flex-wrap:wrap;gap:6px;margin:3px 0 7px}",
      ".c2d-accItem{font-size:11px;padding:1px 7px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f4f5f7);color:var(--dsw-alias-label-secondary,#5f6672)}",
      "@media (max-width:900px){.c2d-two{grid-template-columns:1fr}}",
    ].join("");
    document.head.appendChild(st);
  }

  /* ── 渲染片段 ─────────────────────────────────────────────────────── */

  const card = (k, v, u, f, tone) =>
    '<div class="c2d-card ' + (tone || "") + '">' +
    '<div class="k">' + esc(k) + "</div>" +
    '<div class="v">' + esc(v) + (u ? '<span class="u">' + esc(u) + "</span>" : "") + "</div>" +
    (f ? '<div class="f">' + f + "</div>" : "") +
    "</div>";

  const section = (title, body) =>
    '<div class="c2d-section"><div class="c2d-sectionTitle">' + esc(title) + "</div>" + body + "</div>";

  function cards(list) {
    return '<div class="c2d-cards">' + list.join("") + "</div>";
  }

  function renderGateway(d) {
    const g = d.gateway || {};
    const gw = g.gateway || {};
    const ok = g.ok === true;
    const modelCount = gw.modelCount !== undefined ? gw.modelCount : (d.models || []).length;
    const acc = d.accounts || [];
    const enabled = acc.filter((a) => a.enabled).length;
    const port = gw.address && gw.address.port !== undefined ? gw.address.port : "?";
    return cards([
      card("服务状态", ok ? "运行中" : "异常", "", "监听 127.0.0.1:" + port, ok ? "ok" : "bad"),
      card("上游渠道", (g.providers || []).length, "个", "已接通的 provider"),
      card("可用模型", fmt(modelCount), "个", "网关下发的模型总数", "brand"),
      card("账号池", enabled + " / " + acc.length, "", "启用 / 总数"),
      card("调用方 key", fmt(d.callers && d.callers.keys), "把",
        "分组 " + (d.callers && d.callers.groups !== undefined ? d.callers.groups : 0) + " 个"),
      card("数据快照", ago(d.generatedAt), "", "每 30 秒自动刷新"),
    ]);
  }

  function renderUsage(d) {
    const t = d.usage && d.usage.today;
    if (!t) return '<div class="c2d-empty">今天还没有请求记录</div>';
    const ledger = (d.ledger || []).find((x) => x.date === t.date) || {};
    const rate = t.requests > 0 ? (t.ok / t.requests) * 100 : null;
    const tone = rate === null ? "" : rate >= 99 ? "ok" : rate >= 95 ? "warn" : "bad";
    const cacheRead = ledger.cacheRead || 0;
    const cacheBase = (t.inTokens || 0) + cacheRead;
    const cacheRate = cacheBase > 0 ? ((cacheRead / cacheBase) * 100).toFixed(1) : "0.0";
    return cards([
      card("今日请求", fmt(t.requests), "次", "成功 " + fmt(t.ok) + " · 失败 " + fmt(t.errors)),
      card("成功率", rate === null ? "—" : rate.toFixed(1), "%", "按今日请求统计", tone),
      card("输入 tokens", fmtTokens(t.inTokens), "", "上下文占大头", "brand"),
      card("输出 tokens", fmtTokens(t.outTokens), "", "生成部分"),
      card("缓存命中", cacheRate, "%", "缓存读 " + fmtTokens(cacheRead)),
      card("首字延迟", ledger.ttftAvgMs ? fmt(ledger.ttftAvgMs) + " ms" : "—", "", "平均 TTFT"),
    ]);
  }

  function renderTrend(hostId, axisId, days, pick, fn) {
    const host = document.getElementById(hostId);
    const axis = document.getElementById(axisId);
    if (!host || !axis) return;
    if (!days || !days.length) {
      host.innerHTML = '<div class="c2d-muted" style="margin:auto;font-size:11.5px">暂无数据</div>';
      axis.innerHTML = "";
      return;
    }
    const vals = days.map(pick);
    const max = Math.max(1, Math.max.apply(null, vals));
    host.innerHTML = days.map(function (day, i) {
      if (day.empty) {
        return '<div class="col" title="' + esc(day.date) + '：无数据"><i class="nodata" style="height:2px"></i></div>';
      }
      const h = Math.max(2, Math.round((vals[i] / max) * 100));
      return '<div class="col" title="' + esc(day.date) + "：" + esc(fn(vals[i])) + '"><i style="height:' + h + '%"></i></div>';
    }).join("");
    axis.innerHTML = days.map(function (day) {
      return "<span" + (day.empty ? ' class="nodata"' : "") + ">" + esc(day.date.slice(5)) + "</span>";
    }).join("");
  }

  function renderAccounts(d) {
    const accounts = d.accounts || [];
    if (!accounts.length) return '<div class="c2d-empty">账号池为空</div>';
    const byAcc = {};
    Object.keys(d.balances || {}).forEach(function (p) {
      const pack = d.balances[p];
      (pack && pack.accounts || []).forEach(function (row) { byAcc[row.accountId] = Object.assign({}, row, { provider: p }); });
    });
    const rows = accounts.map(function (a) {
      const bal = byAcc[a.id];
      const pkgs = (bal && bal.balance && bal.balance.packages) || [];
      const total = bal && bal.balance ? bal.balance.total : undefined;

      let balCell;
      if (bal && bal.error !== undefined) {
        balCell = '<span class="c2d-err">' + esc(bal.error) + "</span>";
      } else if (!bal) {
        balCell = '<span class="c2d-muted">—</span>';
      } else if (!pkgs.length) {
        balCell = '<span class="c2d-muted">无积分包</span>';
      } else {
        balCell = pkgs.slice(0, 4).map(function (p) {
          const pct = p.total > 0 ? (p.remaining / p.total) * 100 : 0;
          const tone = pct > 30 ? "" : pct > 10 ? "warn" : "bad";
          return '<div class="c2d-pkg">' +
            '<div class="c2d-pkgName">' + esc(p.name) + ' <span class="c2d-muted">' + fmt(p.remaining) + "/" + fmt(p.total) + "</span></div>" +
            '<div class="c2d-bar"><i class="' + tone + '" style="width:' + Math.min(100, pct).toFixed(1) + '%"></i></div>' +
            "</div>";
        }).join("");
      }

      let expCell;
      if (a.expiresAt === undefined) {
        expCell = '<span class="c2d-muted">长期 / 静态</span>';
      } else {
        /* tone 用毫秒差判断，不用取整后的天数：否则「还剩 2 小时」会被算成
           0 天而落进最紧急的红档，与还剩 23 小时显示同色，看不出轻重。 */
        const msLeft = a.expiresAt - Date.now();
        const tone = msLeft > 7 * 86400000 ? "ok" : msLeft > 2 * 86400000 ? "warn" : "bad";
        expCell = '<span class="c2d-dot ' + tone + '"></span>' + esc(a.expiryText || "已过期");
      }

      const state = a.enabled
        ? '<span class="c2d-dot ok"></span>启用'
        : '<span class="c2d-dot off"></span>停用';
      const rl = a.rateLimited > 0
        ? '<span title="' + esc(a.rateLimitedModels || "") + '" style="color:var(--dsw-alias-state-warn-primary,#b45309)">' + a.rateLimited + " 模型限流</span>"
        : '<span class="c2d-muted">正常</span>';

      return "<tr>" +
        "<td><span class=\"c2d-chanCell\">" + providerHeadTag(a.provider) + "</span></td>" +
        "<td>" + esc(a.nickname || a.id) + "</td>" +
        "<td>" + state + "</td>" +
        "<td>" + expCell + "</td>" +
        "<td>" + rl + "</td>" +
        '<td class="num">' + (total !== undefined ? "<strong>" + fmt(total) + "</strong>" : "—") + "</td>" +
        "<td>" + balCell + "</td>" +
        "</tr>";
    }).join("");

    const cached = d.balancesCachedAt ? " · " + ago(new Date(d.balancesCachedAt).toISOString()) : "";
    return '<table class="c2d-tbl"><thead><tr>' +
      "<th>渠道</th><th>账号</th><th>状态</th><th>凭据有效期</th><th>限流</th>" +
      '<th class="num">余额合计</th><th>积分包（缓存 5 分钟' + esc(cached) + "）</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function renderModels(d) {
    const models = d.models || [];
    const byP = {};
    models.forEach(function (m) {
      const p = String(m.id || "").split("/")[0] || "?";
      byP[p] = (byP[p] || 0) + 1;
    });
    const sorted = Object.keys(byP).map(function (k) { return [k, byP[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
    const max = sorted.length ? sorted[0][1] : 1;

    const left = sorted.length
      ? '<table class="c2d-tbl"><thead><tr><th>渠道</th><th class="num">模型数</th><th>占比</th></tr></thead><tbody>' +
        sorted.map(function (x) {
          const pct = (x[1] / max) * 100;
          return "<tr>" +
            "<td><span class=\"c2d-chanCell\">" + providerHeadTag(x[0]) + "</span></td>" +
            '<td class="num">' + fmt(x[1]) + "</td>" +
            '<td style="width:52%"><div class="c2d-bar" style="margin:0"><i class="brand" style="width:' + pct.toFixed(1) + '%"></i></div></td>' +
            "</tr>";
        }).join("") + "</tbody></table>"
      : '<div class="c2d-empty">模型清单为空</div>';

    const used = (d.usage && d.usage.today && d.usage.today.models) || {};
    const usedSorted = Object.keys(used).map(function (k) { return [k, used[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);
    const right = usedSorted.length
      ? '<table class="c2d-tbl"><thead><tr><th>今日使用的模型</th><th class="num">请求数</th></tr></thead><tbody>' +
        usedSorted.map(function (x) {
          return '<tr><td><span class="c2d-ch">' + esc(x[0]) + '</span></td><td class="num">' + fmt(x[1]) + "</td></tr>";
        }).join("") + "</tbody></table>"
      : '<div class="c2d-empty">今天还没有调用</div>';

    return '<div class="c2d-two"><div>' + left + "</div><div>" + right + "</div></div>";
  }

  /**
   * 金额/额度显示：积分常带小数（codearts 4599.89），四舍五入成整数会丢精度。
   */
  function fmtAmt(n) {
    const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
    if (Math.abs(v - Math.round(v)) < 0.005) return fmt(v);
    return v.toFixed(2);
  }

  /** 毫秒时间戳 → 「YYYY-MM-DD HH:mm」（本地时区，与面板其它时间一致）。 */
  function when(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /** 距现在还有多少天（可为负）；无到期时间返回 null。 */
  function leftDays(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
    return Math.floor((ms - Date.now()) / 86400_000);
  }

  /**
   * 积分收支。
   *
   * ⚠️ 口径是账本级：上游 credits.balances 只回每个包的 total / used / remaining，
   *    没有逐笔流水接口。所以「收入」= 包的总额度、「支出」= 已消耗、「结余」= 剩余。
   *    不要在这里造逐笔记录。
   */
  /*
   * 渠道中文名 + 官方 logo。
   *
   * ⚠️ 不要自己画 SVG 或引外链：上游 public/upstream-jet-hub.js 的 PROVIDER_ICONS 是 base64
   *    内联在构建产物里的，本模块拿不到。正确做法是直接读左侧原生供应商行里的 img 标签（同源、
   *    已在 DOM、CSP 的 img-src 'self' 放行、零网络请求）。左侧行不存在时退回纯文字。
   */
  var PROVIDER_LABELS = {
    codearts: "CodeArts (华为云)", buddy: "CodeBuddy (腾讯)", workbuddy: "WorkBuddy (国际版)",
    lobsterai: "LobsterAI (有道)", qoder: "Qoder", qodercn: "Qoder (中国版)",
    trae: "TRAE (字节)", cline: "Cline", loomy: "Loomy (讯飞)", raccoon: "Raccoon (商汤)",
    minimax: "MiniMax Code (中国版)", minimaxintl: "MiniMax Code (国际版)",
    zcode: "ZCode (智谱)", opencode: "OpenCode", gemini: "Gemini Code Assist",
    officeace: "OfficeAce", accio: "Accio (阿里)", astudio: "AStudio (讯飞)",
    autoclaw: "AutoClaw (智谱)", autoclawintl: "AutoClaw (国际版)",
    qiniu: "Qiniu (七牛云)", codely: "Codely (Unity)", magicrew: "超级麦吉",
    aggregate: "聚合 (跨渠道)", "jet-hub-auto": "Jet Hub Auto", modelscope: "ModelScope (魔搭)",
  };

  /** 渠道中文名：优先读左侧原生供应商行的标签，其次查表，最后退回 id 本身。 */
  function providerLabel(prov) {
    var row = document.querySelector('.dim-jh-providerRow[data-provider="' + prov + '"]');
    var txt = row && row.querySelector('.dim-jh-providerLabel strong');
    if (txt && txt.textContent && txt.textContent.trim()) return txt.textContent.trim();
    if (PROVIDER_LABELS[prov]) return PROVIDER_LABELS[prov];
    return prov;
  }

  /** 渠道 logo：借左侧原生供应商行里的官方图标（同源内联图，不发请求）。 */
  function providerIconUrl(prov) {
    var img = document.querySelector('.dim-jh-providerRow[data-provider="' + prov + '"] img');
    return img && img.src ? img.src : "";
  }

  /** 渠道头部：logo + 中文名（无图标时只出名字）。 */
  function providerHeadTag(prov) {
    var url = providerIconUrl(prov);
    var ico = url ? '<span class="c2d-ico"><img src="' + esc(url) + '" alt=""></span>' : "";
    return ico + '<span class="c2d-chanName">' + esc(providerLabel(prov)) + "</span>" +
      '<span class="c2d-ch">' + esc(prov) + "</span>";
  }
  function renderCredits(d) {
    const cr = d.credits;
    if (!cr || !cr.packages || cr.packages.length === 0) {
      return '<div class="c2d-empty">当前没有任何渠道上报积分包（或余额接口暂不可用）</div>';
    }

    /* ① 按单位汇总卡：不能把 credits / credit / token / 通道 相加 */
    const unitCards = cr.units.map(function (u) {
      const pctUsed = u.total > 0 ? (u.used / u.total) * 100 : 0;
      return card("剩余 · " + u.unit, fmtAmt(u.remaining), "", 
        "已用 " + fmtAmt(u.used) + " / 总量 " + fmtAmt(u.total) +
        " · 使用率 " + pctUsed.toFixed(1) + "% · " + u.packs + " 个包",
        pctUsed >= 90 ? "bad" : pctUsed >= 60 ? "warn" : "ok");
    });

    const warn7 = cr.expiry.d7.length;
    const warn30 = cr.expiry.d30.length;
    const stale = cr.expiry.expired.length;
    const warnCard = card("7 天内到期", String(warn7), "个包",
      warn7 ? "其中剩余量见下方预警" : "暂无临近到期", warn7 ? "bad" : "ok");
    const laterCard = card("8–30 天内到期", String(warn30), "个包",
      "合计 " + String(warn7 + warn30) + " 个包在 30 天内到期", warn30 ? "warn" : "");
    const staleCard = stale
      ? card("已过期未清零", String(stale), "个包", "剩余额度已不可用", "bad") : "";

    const head = cards(unitCards.concat([warnCard, laterCard]).concat(staleCard ? [staleCard] : []));

    /* ② 按渠道明细：一个渠道一块，头部是中文名 + logo + 该渠道收支合计，下面挂它自己的每个积分包 */
    const chanMap = new Map();
    cr.packages.forEach(function (p) {
      if (!chanMap.has(p.provider)) chanMap.set(p.provider, []);
      chanMap.get(p.provider).push(p);
    });
    const chanBlocks = Array.from(chanMap.keys()).sort().map(function (prov) {
      const list = chanMap.get(prov).slice().sort(function (a, b) {
        if (b.remaining !== a.remaining) return b.remaining - a.remaining;
        return a.name < b.name ? -1 : 1;
      });
      const agg = { total: 0, used: 0, remaining: 0 };
      const units = [];
      const accMap = new Map();
      list.forEach(function (p) {
        agg.total += p.total; agg.used += p.used; agg.remaining += p.remaining;
        if (units.indexOf(p.unit) < 0) units.push(p.unit);
        const ak = p.accountId || "?";
        const a = accMap.get(ak) ||
          { accountId: ak, nickname: p.nickname, total: 0, used: 0, remaining: 0, packs: 0 };
        a.total += p.total; a.used += p.used; a.remaining += p.remaining; a.packs += 1;
        accMap.set(ak, a);
      });
      const pct = agg.total > 0 ? (agg.used / agg.total) * 100 : 0;
      const tone = pct >= 90 ? "bad" : pct >= 60 ? "warn" : "brand";
      let html = '<div class="c2d-chan">' +
        '<div class="c2d-chanHead">' + providerHeadTag(prov) +
        '<span class="c2d-unit">' + esc(units.join(" · ")) + "</span>" +
        '<span class="c2d-chanSum">收入 ' + fmtAmt(agg.total) +
          " · 支出 " + fmtAmt(agg.used) +
          " · 结余 " + fmtAmt(agg.remaining) +
          " · 使用率 " + pct.toFixed(1) + "%" +
          " · " + String(list.length) + " 个包 / " + String(accMap.size) + " 个账号</span>" +
        "</div>" +
        '<div class="c2d-bar" style="margin:0 0 7px"><i class="' + tone + '" style="width:' +
          Math.min(100, pct).toFixed(1) + '%"></i></div>';
      if (accMap.size > 1) {
        html += '<div class="c2d-accs">' + Array.from(accMap.values()).map(function (a) {
          return '<span class="c2d-accItem">' + esc(a.nickname || a.accountId) +
            " · 结余 " + fmtAmt(a.remaining) + " / " + fmtAmt(a.total) + " · " + String(a.packs) +
            " 个包</span>";
        }).join("") + "</div>";
      }
      html += '<table class="c2d-tbl"><thead><tr>' +
        "<th>包名</th><th>账号</th>" +
        '<th class="num">总量</th><th class="num">已用</th><th class="num">剩余</th>' +
        "<th>使用率</th><th>到期</th>" +
        "</tr></thead><tbody>" +
        list.map(function (p) {
          const up = p.total > 0 ? (p.used / p.total) * 100 : 0;
          const t = up >= 90 ? "bad" : up >= 60 ? "warn" : "";
          const dl = leftDays(p.endAt);
          const endText = p.endAt === null ? "无期限"
            : when(p.endAt) + (dl !== null && dl >= 0 ? "（" + dl + " 天）" : "（已过期）");
          return "<tr>" +
            "<td>" + esc(p.name) + "</td>" +
            '<td class="c2d-muted">' + esc(p.nickname || p.accountId || "") + "</td>" +
            '<td class="num">' + fmtAmt(p.total) + "</td>" +
            '<td class="num">' + fmtAmt(p.used) + "</td>" +
            '<td class="num">' + fmtAmt(p.remaining) + "</td>" +
            '<td style="width:13%"><div class="c2d-bar" style="margin:0"><i class="' + t +
              '" style="width:' + Math.min(100, up).toFixed(1) + '%"></i></div></td>' +
            '<td class="c2d-muted">' + endText + "</td>" +
            "</tr>";
        }).join("") +
        "</tbody></table></div>";
      return html;
    }).join("");

    /* ③ 到期预警：只列还有余额且即将到期的包 */
    const urgent = cr.expiry.d7.concat(cr.expiry.d30).slice(0, 12);
    const urgentTable = urgent.length
      ? '<div class="c2d-sub2">即将到期（30 天内，且仍有余额）</div>' +
        '<table class="c2d-tbl"><thead><tr>' +
        "<th>剩余</th><th>包名</th><th>渠道 / 账号</th><th>到期</th><th>还剩</th>" +
        "</tr></thead><tbody>" +
        urgent.map(function (p) {
          const dl = leftDays(p.endAt);
          const tone = dl !== null && dl <= 7 ? "bad" : "warn";
          return "<tr>" +
            '<td class="num">' + fmtAmt(p.remaining) + ' <span class="c2d-unit">' + esc(p.unit) + "</span></td>" +
            "<td>" + esc(p.name) + "</td>" +
            "<td><span class=\"c2d-chanCell\">" + providerHeadTag(p.provider) +
              ' <span class="c2d-muted">' + esc(p.nickname || p.accountId || "") + "</span></span></td>" +
            "<td>" + when(p.endAt) + "</td>" +
            '<td><span class="c2d-dot ' + tone + '"></span>' + (dl !== null ? dl + " 天" : "—") + "</td>" +
            "</tr>";
        }).join("") + "</tbody></table>"
      : '<div class="c2d-muted" style="font-size:11.5px">30 天内没有到期且仍有余额的积分包。</div>';

    return head +
      '<div class="c2d-sub2">按渠道明细（账本级：收入 = 包的总额度，支出 = 已消耗，结余 = 剩余；共 ' +
        String(chanMap.size) + " 个渠道 / " + String(cr.packages.length) + " 个积分包）</div>" +
      chanBlocks + urgentTable;
  }

  function renderCheckin(d) {
    const c = d.checkin;
    if (!c) return '<div class="c2d-empty">没有签到状态文件</div>';
    const ok = c.ranToday === true;
    // lagDays 由后端按 UTC+8 日键算好：0 = 今天已签，1 = 昨天签的、今天没签，以此类推。
    const lag = typeof c.lagDays === "number" ? c.lagDays : null;
    const lastText = !c.lastDate ? "还没有记录"
      : lag === 0 ? "今天 " + esc(c.lastDate)
      : lag !== null && lag > 0 ? "上次 " + esc(c.lastDate) + "（已隔 " + lag + " 天）"
      : "上次 " + esc(c.lastDate);
    const atText = typeof c.lastAt === "number" && c.lastAt > 0 ? when(c.lastAt) : "—";
    const head = cards([
      card("今日签到", ok ? "已完成" : "未完成", "", lastText, ok ? "ok" : "warn"),
      card("自动签到", c.enabled ? "已开启" : "已关闭", "",
        "systemd 启动 30 秒 + cron 每日 00:05", c.enabled ? "ok" : "warn"),
      card("最近执行", atText, "", esc(c.lastResult || "—"), ok ? "" : "warn"),
    ]);
    const rows = (c.channels || []).map(function (ch) {
      const t = String(ch.text || "");
      const tone = t.indexOf("已领") >= 0 || t.indexOf("已完成") >= 0 ? "ok"
        : t.indexOf("不支持") >= 0 || t.indexOf("手动") >= 0 ? "warn" : "bad";
      return "<tr><td><span class=\"c2d-ch\">" + esc(ch.provider) + "</span></td>" +
        '<td><span class="c2d-dot ' + tone + '"></span>' + esc(t) + "</td></tr>";
    }).join("");
    return head + '<table class="c2d-tbl" style="margin-top:8px"><thead><tr><th>渠道</th><th>签到状态</th></tr></thead><tbody>' +
      rows + "</tbody></table>";
  }

  /* ── 弹窗骨架（复用原生 .dim-jh-modal*） ──────────────────────────── */

  function build() {
    const ov = document.createElement("div");
    ov.className = "dim-jh-modalOverlay";
    ov.setAttribute("data-c2d", "1");
    ov.innerHTML =
      '<div role="dialog" aria-modal="true" aria-label="总览" class="dim-jh-modal dim-jh-modal--ledger">' +
      '<div class="dim-jh-modalHead">' +
      '<div class="dim-jh-modalTitle"><strong>总览</strong>' +
      '<span class="dim-jh-modalSubtitle" id="c2d-sub">加载中…</span></div>' +
      '<div class="dim-jh-modelPanelActions">' +
      '<button class="dim-jh-btn" id="c2d-refresh" title="重新读取全部数据（余额会绕过 5 分钟缓存）。">刷新</button>' +
      '<button class="dim-jh-btn" data-kind="primary" id="c2d-close">完成</button>' +
      "</div></div>" +
      '<p class="dim-jh-modalHint">网关运行状态、今日用量、近 14 日趋势、渠道账号与余额、积分收支、模型分布、自动签到。' +
      "余额最多缓存 5 分钟；数据全部读本机文件，不向上游发请求。</p>" +
      '<div class="dim-jh-modalBody"><div class="c2d-body" id="c2d-body"></div></div>' +
      "</div>";

    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    ov.querySelector("#c2d-close").addEventListener("click", close);
    ov.querySelector("#c2d-refresh").addEventListener("click", function () {
      const b = ov.querySelector("#c2d-refresh");
      b.disabled = true;
      load(true).finally(function () { b.disabled = false; });
    });
    return ov;
  }

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    stopTimer();
    document.removeEventListener("keydown", onKey);
  }

  function onKey(e) { if (e.key === "Escape") close(); }

  function open() {
    ensureStyle();
    if (overlay) return;
    overlay = build();
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    // 上次的快照先画出来（毫秒级），随后 load 再更新。
    // 用户报「总览点开很慢」：冷启动首个 dashboard/api 要 0.64s，
    // 首次打开逃不掉，但再次打开不该再等一次。
    if (lastSnapshot) paint(lastSnapshot);
    load(false);
    startTimer();
  }

  function startTimer() {
    stopTimer();
    timer = setInterval(function () {
      if (document.visibilityState === "visible" && overlay) load(false);
    }, REFRESH_MS);
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  /* ── 数据加载 ─────────────────────────────────────────────────────── */

  async function load(fresh) {
    const body = overlay && overlay.querySelector("#c2d-body");
    const sub = overlay && overlay.querySelector("#c2d-sub");
    if (!body) return;
    try {
      const res = await fetch(API + (fresh ? "?fresh=1" : ""), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const d = await res.json();
      if (!overlay) return;
      lastSnapshot = d;
      paint(d);
    } catch (err) {
      if (sub) sub.textContent = "加载失败：" + err.message;
      body.innerHTML = '<div class="c2d-empty">加载失败：' + esc(err.message) + "</div>";
    }
  }

  /** 把一份快照画进弹窗。抽成独立函数是为了让「再次打开」能直接复用上次结果。 */
  function paint(d) {
    const body = overlay && overlay.querySelector("#c2d-body");
    const sub = overlay && overlay.querySelector("#c2d-sub");
    if (!body) return;
    body.innerHTML =
      section("网关状态", renderGateway(d)) +
      section("今日用量", renderUsage(d)) +
      section("近 14 日趋势",
        '<div class="c2d-two">' +
        '<div><div class="c2d-trend" id="c2d-trend-req"></div>' +
        '<div class="c2d-axis" id="c2d-axis-req"></div>' +
        '<div class="c2d-muted" style="font-size:11px;margin-top:3px">每日请求数</div></div>' +
        '<div><div class="c2d-trend" id="c2d-trend-tok"></div>' +
        '<div class="c2d-axis" id="c2d-axis-tok"></div>' +
        '<div class="c2d-muted" style="font-size:11px;margin-top:3px">每日 Token 总量</div></div>' +
        "</div>") +
      section("渠道账号与余额", renderAccounts(d)) +
      section("积分收支", renderCredits(d)) +
      section("模型分布", renderModels(d)) +
      section("自动签到", renderCheckin(d));

    const days = (d.usage && d.usage.days) || [];
    renderTrend("c2d-trend-req", "c2d-axis-req", days, function (x) { return x.requests; }, fmt);
    renderTrend("c2d-trend-tok", "c2d-axis-tok", days,
      function (x) { return (x.inTokens || 0) + (x.outTokens || 0); }, fmtTokens);

    if (sub) sub.textContent = "快照 " + ago(d.generatedAt) + " · 每 30 秒自动刷新";
  }

  /* ── 把「总览」按钮插进原生 header ───────────────────────────────── */

  function mountButton() {
    if (document.querySelector("[data-c2d-btn]")) return true;
    const actions = document.querySelector(".dim-jh-headerActions");
    const host = actions || document.querySelector(".dim-jh-header") || document.querySelector("header");
    if (!host) return false;
    const btn = document.createElement("button");
    btn.className = "dim-jh-btn";
    btn.setAttribute("data-c2d-btn", "1");
    btn.title = "总览：网关状态、今日用量、近 14 日趋势、渠道余额、积分收支、模型分布、自动签到。";
    btn.textContent = "总览";
    btn.addEventListener("click", open);
    // 「总览」排在原生按钮最前面（用户要求：放在「供应商」之前）。
    host.insertBefore(btn, host.firstChild);
    return true;
  }

  // 原生后台是单页应用，切渠道会重渲染 header —— 用常驻 MutationObserver 保证按钮不丢。
  let raf = 0;
  const obs = new MutationObserver(function () {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      mountButton();
    });
  });
  if (!mountButton()) {
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const t0 = setInterval(function () { if (mountButton()) { clearInterval(t0); } }, 500);
  } else {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
`
