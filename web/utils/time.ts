/**
 * 时间格式化统一用 dayjs（中文 i18n）。不要再手写「几分钟前 / YYYY-MM-DD」这类逻辑。
 */
import dayjs from "dayjs"
import relativeTime from "dayjs/plugin/relativeTime"
import "dayjs/locale/zh-cn"

dayjs.extend(relativeTime)
dayjs.locale("zh-cn")

export { dayjs }

/** 相对时间（「3 分钟前」）；未来/刚发生统一「刚刚」。 */
export function ago(iso?: string | null): string {
  if (!iso) return "—"
  const t = dayjs(iso)
  if (!t.isValid()) return "—"
  if (t.valueOf() > Date.now()) return "刚刚"
  if (dayjs().diff(t, "second") < 5) return "刚刚"
  return t.fromNow()
}

/** 毫秒时间戳 → 「YYYY-MM-DD HH:mm」。 */
export function when(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return "—"
  const t = dayjs(ms)
  return t.isValid() ? t.format("YYYY-MM-DD HH:mm") : "—"
}

/** → 「HH:mm:ss」。 */
export function hhmmss(value?: string | null): string {
  if (!value) return "—"
  const t = dayjs(value)
  return t.isValid() ? t.format("HH:mm:ss") : "—"
}

/** → 本地日期键「YYYY-MM-DD」。 */
export function dayKey(value: dayjs.ConfigType): string {
  const t = dayjs(value)
  return t.isValid() ? t.format("YYYY-MM-DD") : ""
}

/** 星期几（中文，如「周一」）。 */
export function weekdayShort(value: string): string {
  const t = dayjs(value)
  return t.isValid() ? t.format("dd") : ""
}
