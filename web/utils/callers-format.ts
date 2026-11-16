/** 调用方视图的数值/状态/日期文本格式化（时间基于 dayjs，纯文本，不拼 HTML）。 */
import { dayjs, weekdayShort } from "./time"

export function fmt(n: any): string {
  const v = Number(n)
  if (!isFinite(v)) return "—"
  return Math.round(v).toLocaleString("zh-CN")
}

export function fmtTokens(n: any): string {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(2) + " 亿"
  if (v >= 1e4) return (v / 1e4).toFixed(1) + " 万"
  return fmt(v)
}

export function fmtMs(ms: any): string {
  const v = Number(ms)
  if (ms == null || !isFinite(v)) return "—"
  if (v < 1000) return Math.round(v) + " ms"
  if (v < 60000) return (v / 1000).toFixed(1) + " s"
  const s = Math.round(v / 1000)
  return Math.floor(s / 60) + " 分 " + String(s % 60).padStart(2, "0") + " 秒"
}

const STATUS_TEXT: Record<number, string> = {
  400: "请求有误",
  401: "Key 无效",
  403: "无权调用",
  404: "模型不存在",
  408: "请求超时",
  413: "请求过大",
  429: "被限流",
  500: "服务出错",
  502: "上游出错",
  503: "暂不可用",
  504: "上游超时",
}
const CODE_TEXT: Record<string, string> = {
  rate_limit_exceeded: "被限流",
  insufficient_quota: "额度不足",
  quota_exceeded: "额度不足",
  model_not_allowed: "无权调用",
  model_disabled: "模型已关闭",
  invalid_api_key: "Key 无效",
  context_length_exceeded: "上下文超长",
  gateway_unreachable: "网关不可达",
  server_error: "服务出错",
  timeout: "超时",
  upstream_error: "上游出错",
}

export function statusReason(x: any): string {
  if (x.error_code) return CODE_TEXT[x.error_code] || String(x.error_code)
  const s = Number(x.status)
  return STATUS_TEXT[s] || (s >= 500 ? "服务出错" : "请求失败")
}

export function recKey(x: any): string {
  return [x.ts, x.caller, x.model, x.status, x.ms, x.in_tokens, x.out_tokens].join("|")
}

export function localDay(value: any): string {
  const t = dayjs(value)
  return t.isValid() ? t.format("YYYY-MM-DD") : ""
}

export function dayHead(day: string): string {
  if (!day) return "日期未知"
  const d = dayjs(day)
  if (!d.isValid()) return String(day)
  const now = dayjs()
  const lead =
    day === now.format("YYYY-MM-DD")
      ? "今天"
      : day === now.subtract(1, "day").format("YYYY-MM-DD")
        ? "昨天"
        : d.format("YYYY 年")
  return lead + " · " + d.format("M 月 D 日") + " " + d.format("ddd")
}

export function wd(day: string): string {
  return weekdayShort(day)
}

/** 日期多选下拉的显示文本。 */
export function daysText(picked: string[]): string {
  const list = (picked || []).slice().sort().reverse()
  if (list.length === 0) return "未选择 · 默认今天"
  if (list.length === 1) {
    const w = wd(list[0])
    return list[0] + (w ? " " + w : "")
  }
  return "已选 " + list.length + " 天 · " + list[list.length - 1] + " → " + list[0]
}

export function presetSet(kind: string, avail: string[]): string[] | null {
  const all = (avail || []).slice()
  if (kind === "latest") return all.slice(0, 1)
  if (kind === "yesterday") return all.slice(1, 2)
  if (kind === "3") return all.slice(0, 3)
  if (kind === "7") return all.slice(0, 7)
  if (kind === "all") return all
  if (kind === "none") return []
  return null
}

export function sameSet(a: string[], b: string[]): boolean {
  return (a || []).slice().sort().join(",") === (b || []).slice().sort().join(",")
}
