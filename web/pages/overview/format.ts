/** 总览用到的数值格式化（时间格式统一走 utils/time 的 dayjs）。 */

export function fmt(value: any): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—"
  return Math.round(value).toLocaleString("zh-CN")
}

export function fmtTokens(value: any): string {
  const amount = Number(value) || 0
  if (amount >= 1e8) return (amount / 1e8).toFixed(2) + " 亿"
  if (amount >= 1e4) return (amount / 1e4).toFixed(1) + " 万"
  return fmt(amount)
}

export function fmtAmt(value: any): string {
  const amount = typeof value === "number" && Number.isFinite(value) ? value : 0
  if (Math.abs(amount - Math.round(amount)) < 0.005) return fmt(amount)
  return amount.toFixed(2)
}

/** 距现在还有多少天（可为负）；无到期时间返回 null。 */
export function leftDays(ms: any): number | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null
  return Math.floor((ms - Date.now()) / 86400_000)
}

/**
 * 缓存命中率（缓存读 / (输入 + 缓存读)）。
 *
 * ⚠️ 输入为 0 时返回「—」，不能算成 100%：输入来自本地 `caller-usage`，
 * 缓存读来自上游 `token-ledger.json`。请求没经过本服务 `/v1` 反代时输入就是 0，
 * 而 ledger 仍有缓存读 —— 直接相除会显示「100.0%」，与同一张卡上的
 * 「今日请求 0」自相矛盾（实测用户报障即为此形态）。
 */
export function cacheHitRate(inTokens: any, cacheRead: any): string {
  const input = Number(inTokens) || 0
  const cached = Number(cacheRead) || 0
  if (input <= 0 || cached < 0) return "—"
  return ((cached / (input + cached)) * 100).toFixed(1)
}
