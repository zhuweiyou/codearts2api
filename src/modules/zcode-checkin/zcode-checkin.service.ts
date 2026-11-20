/**
 * ZCode 自动签到（宿主层调度，领取逻辑全部复用上游）。
 *
 * ## 为什么调度在本仓库、而不是上游
 *
 * 上游 `dsh-providers-hub` 的每日自动签到**刻意排除** zcode（registry 的
 * `autoCheckinExcluded`）：每次领取都要现场产一个阿里云 captcha，web 版会拉起
 * headful Chromium，DSH 桌面场景下「用户什么都没点就起浏览器」不可接受。
 * 但领取协议本身上游已完整实现（`credits.claimAll` 的 zcode 分支：补激活上报 →
 * preview + 营销投放 → 逐 plan claim，每个 plan 现产 captcha），面板「一键领取」
 * 走的就是它。本模块只补**调度**：到点调一次那条 RPC，不复制任何领取逻辑。
 *
 * ## 时段为什么在晚间（同类脚本的口径）
 *
 * 社区所谓「zcode 签到」实为限时套餐领取，投放每天 **北京时间 19:00** 才开始
 * （协议与窗口见 hj01857655/Zcode2api 的 docs/CLAIM.md，源自青龙脚本
 * L0NE-6/ZCode-Daily 的抓包）。上午去领只会拿到空 plans，故按 Zcode2api 的
 * claimSlots 在 **19:05 / 20:05 / 21:05 / 22:05** 各试一次覆盖投放延迟；
 * 领取幂等（已领过回 1003，上游归为 already-claimed），多跑一轮无副作用。
 *
 * ## 状态与开关
 *
 * - 状态落 `<home>/zcode-auto-checkin.json`（本模块独占，上游不读不写）；
 * - 面板开关写 `enabled`；`CODEARTS2API_ZCODE_AUTO_CHECKIN=0` 强制关闭时
 *   面板置灰（`envLocked`，与网关 env > 面板的优先级同族）；
 * - 每个时段按**北京日**记水位线（`date` + `ranSlots`），启动后补跑最近一个
 *   已到点且当天没跑过的时段 —— 与上游自动签到「启动后补跑」同语义。
 *
 * ## 浏览器依赖（如实告知，不掩盖）
 *
 * captcha 由上游经 headful Chromium 产出（headless 实测恒 F001），需要本机有
 * Chrome/Edge（或 `ZCODE_CHROME_PATH` 指定）。Docker 镜像不含浏览器，领取会
 * 如实失败并记进 `lastResult` —— 调度本身不因此停摆，面板能看到失败原因。
 */
import { join } from "node:path"

import { readJson, writeJsonAtomic } from "../../core/fs-store.ts"

/** 领取时段（北京时间，投放 19:00 开始后逐小时兜底；口径同 Zcode2api claimSlots）。 */
export const ZCODE_CHECKIN_SLOTS = ["19:05", "20:05", "21:05", "22:05"]

const SLOT_MINUTES = ZCODE_CHECKIN_SLOTS.map((slot) => {
  const [h, m] = slot.split(":").map(Number)
  return h * 60 + m
})

/** 启动后的补跑延迟：等插件装配稳定（上游自动签到同样延迟 30s）。 */
const START_DELAY_MS = 30_000
/** 巡检周期：分钟级足够（时段粒度是小时），错 tick 由「最近已到点时段」判据自愈。 */
const TICK_MS = 60_000
/** 逐账号明细上限（与上游 auto-checkin 的 channels 上限同量级，防状态文件膨胀）。 */
const MAX_ACCOUNT_ENTRIES = 24

/** 把时刻换算成北京日期与当日分钟数（固定 UTC+8 偏移，不依赖 IANA tzdb）。 */
export function beijingParts(now: number): { date: string; minutes: number } {
  const shifted = new Date(now + 8 * 3_600_000)
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

/** 当前时刻**最近一个已到点**的时段；19:05 之前返回 undefined（上午领了也是空）。 */
export function dueSlot(minutes: number): string | undefined {
  let due: string | undefined
  for (let i = 0; i < SLOT_MINUTES.length; i++) {
    if (minutes >= SLOT_MINUTES[i]) due = ZCODE_CHECKIN_SLOTS[i]
  }
  return due
}

/** 状态文档（落盘形态）。旧文档 / 坏文档经 sanitizeDoc 后一律可安全读出。 */
interface ZcodeCheckinDoc {
  enabled: boolean
  date: string
  ranSlots: string[]
  lastAt: number
  lastSlot: string
  lastResult: { ok: boolean; text: string; accounts: Array<Record<string, unknown>> } | null
}

function sanitizeDoc(raw: unknown): ZcodeCheckinDoc {
  const record = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const date = typeof record.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.date) ? record.date : ""
  const ranSlots = Array.isArray(record.ranSlots)
    ? record.ranSlots.filter((s): s is string => typeof s === "string" && ZCODE_CHECKIN_SLOTS.includes(s))
    : []
  const result = record.lastResult
  let lastResult: ZcodeCheckinDoc["lastResult"] = null
  if (result !== null && typeof result === "object") {
    const r = result as Record<string, unknown>
    if (typeof r.text === "string") {
      lastResult = {
        ok: r.ok === true,
        text: r.text.slice(0, 200),
        accounts: Array.isArray(r.accounts) ? r.accounts.slice(0, MAX_ACCOUNT_ENTRIES) : [],
      }
    }
  }
  return {
    // 缺省开启：与产品默认一致（env 强制关闭是另一条腿，见 envLocked）。
    enabled: record.enabled !== false,
    date,
    ranSlots: [...new Set(ranSlots)],
    lastAt: typeof record.lastAt === "number" && Number.isFinite(record.lastAt) ? record.lastAt : 0,
    lastSlot: typeof record.lastSlot === "string" ? record.lastSlot : "",
    lastResult,
  }
}

/** 一轮领取的结果摘要（纯函数，便于单测穷尽）。 */
export function summarizeClaim(value: any): { ok: boolean; text: string; accounts: Array<Record<string, unknown>> } {
  const results = Array.isArray(value?.results) ? value.results : []
  const accounts = results.slice(0, MAX_ACCOUNT_ENTRIES).map((r: any) => ({
    id: typeof r?.accountId === "string" ? r.accountId : "",
    nickname: typeof r?.nickname === "string" ? r.nickname : "",
    kind: typeof r?.outcome?.kind === "string" ? r.outcome.kind : "failed",
    message: typeof r?.outcome?.message === "string" ? r.outcome.message.slice(0, 120) : "",
  }))
  if (results.length === 0) return { ok: true, text: "没有 ZCode 账号", accounts }
  const count = (kind: string) => results.filter((r: any) => r?.outcome?.kind === kind).length
  const claimed = count("claimed")
  const already = count("already-claimed")
  const failed = count("failed")
  const parts = [`${results.length} 个账号`]
  if (claimed > 0) parts.push(`领取 ${claimed}`)
  if (already > 0) parts.push(`已领/暂无 ${already}`)
  if (failed > 0) parts.push(`失败 ${failed}`)
  const firstFail = results.find((r: any) => r?.outcome?.kind === "failed")
  if (firstFail?.outcome?.message) parts.push(`（${String(firstFail.outcome.message).slice(0, 80)}）`)
  // 有账号却一个都没领成（全 failed）才算本轮失败；already-claimed 是幂等成功。
  return { ok: failed < results.length, text: parts.join("，"), accounts }
}

export interface ZcodeCheckinDeps {
  home: string
  /** 管理端 RPC（与 dashboard/models 同一条内部通路，不走网络）。 */
  rpc: (method: string, payload: unknown) => Promise<any>
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
  /** env 是否放行（false = 强制关闭，面板置灰）。 */
  envEnabled?: boolean
  /** 时钟注入（测试用）。 */
  now?: () => number
}

export function createZcodeCheckin(deps: ZcodeCheckinDeps) {
  const file = join(deps.home, "zcode-auto-checkin.json")
  const envEnabled = deps.envEnabled !== false
  const now = deps.now ?? (() => Date.now())
  let running = false
  let startTimer: ReturnType<typeof setTimeout> | undefined
  let tickTimer: ReturnType<typeof setInterval> | undefined

  const load = async () => sanitizeDoc(await readJson(file))
  const persist = (doc: ZcodeCheckinDoc) => writeJsonAtomic(file, doc)

  /** 到点跑一轮；未到点 / 已跑过 / 已关闭时静默返回（不记日期、不发请求）。 */
  async function tick(): Promise<boolean> {
    if (running) return false
    const doc = await load()
    if (!envEnabled || !doc.enabled) return false
    const { date, minutes } = beijingParts(now())
    const slot = dueSlot(minutes)
    if (slot === undefined) return false
    if (doc.date !== date) {
      doc.date = date
      doc.ranSlots = []
    }
    if (doc.ranSlots.includes(slot)) return false
    running = true
    try {
      let result: { ok: boolean; text: string; accounts: Array<Record<string, unknown>> }
      try {
        const value = await deps.rpc("credits.claimAll", { provider: "zcode" })
        result = summarizeClaim(value)
      } catch (error) {
        // RPC 异常（插件未就位 / 信封错误）也记为本轮结果：一天四个时段，
        // 下一时段天然重试，不在时段内反复打（与 Zcode2api「各试一次」同口径）。
        result = { ok: false, text: String(error instanceof Error ? error.message : error).slice(0, 200), accounts: [] }
      }
      doc.ranSlots.push(slot)
      doc.lastAt = now()
      doc.lastSlot = slot
      doc.lastResult = result
      await persist(doc)
      const line = `[zcode-checkin] ${date} ${slot} 自动领取：${result.text}`
      if (result.ok) deps.logger?.info?.(line)
      else deps.logger?.warn?.(line)
      return true
    } finally {
      running = false
    }
  }

  function start() {
    if (tickTimer !== undefined) return
    startTimer = setTimeout(() => void tick(), START_DELAY_MS)
    startTimer.unref?.()
    tickTimer = setInterval(() => void tick(), TICK_MS)
    tickTimer.unref?.()
  }

  function stop() {
    if (startTimer !== undefined) clearTimeout(startTimer)
    if (tickTimer !== undefined) clearInterval(tickTimer)
    startTimer = undefined
    tickTimer = undefined
  }

  /** 面板开关。env 强制关闭时拒绝操作（与网关「已被环境变量停用」同族）。 */
  async function setEnabled(enabled: boolean) {
    if (!envEnabled) throw new Error("已被环境变量 CODEARTS2API_ZCODE_AUTO_CHECKIN=0 停用")
    const doc = await load()
    doc.enabled = enabled === true
    await persist(doc)
    return state()
  }

  /** 面板 / 看板读数（现算 ranToday，不透传文件 —— 与上游看板口径同因）。 */
  async function state() {
    const doc = await load()
    const { date, minutes } = beijingParts(now())
    const ranSlots = doc.date === date ? doc.ranSlots : []
    const next = ZCODE_CHECKIN_SLOTS.find((_, i) => SLOT_MINUTES[i] > minutes)
    return {
      enabled: envEnabled && doc.enabled,
      envLocked: !envEnabled,
      slots: [...ZCODE_CHECKIN_SLOTS],
      today: date,
      ranSlots,
      ranToday: ranSlots.length > 0,
      nextSlot: next ?? ZCODE_CHECKIN_SLOTS[0],
      lastAt: doc.lastAt,
      lastSlot: doc.lastSlot,
      lastResult: doc.lastResult,
    }
  }

  return { tick, start, stop, setEnabled, state }
}

export type ZcodeCheckin = ReturnType<typeof createZcodeCheckin>
