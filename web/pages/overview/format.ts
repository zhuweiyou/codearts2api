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
