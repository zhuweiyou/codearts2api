import { useEffect, useRef, useState } from "react"

import { getRecords, getState, type CallerState, type RecordsQuery, type RecordsResult } from "../api/callers"
import { readAutoOn, writeAutoOn } from "../utils/callers-prefs"
import { presetSet, recKey, sameSet } from "../utils/callers-format"

export type CallersTab = "groups" | "keys" | "usage" | "records"
export interface Filter {
  caller: string
  model: string
  status: string
}

export function autoMs(): number {
  const v = Number((window as any).__c2aRecAutoMs)
  return v > 0 ? v : 15000
}
function sameQuery(a: RecordsQuery, b: RecordsQuery): boolean {
  return (
    sameSet(a.days, b.days) &&
    a.filter.caller === b.filter.caller &&
    a.filter.model === b.filter.model &&
    a.filter.status === b.filter.status
  )
}

/**
 * 调用方数据层：state / records / 筛选 / 日期 / 自动刷新。
 * 组件只消费返回值渲染。自动刷新的秒级 tick 也用 ref 保证不读到旧闭包。
 */
export function useCallersData(active: boolean, tab: CallersTab) {
  const [data, setData] = useState<CallerState | null>(null)
  const [records, setRecords] = useState<RecordsResult | null>(null)
  const [filter, setFilter] = useState<Filter>({ caller: "", model: "", status: "" })
  const [days, setDays] = useState<string[]>([])
  const [daysOpen, setDaysOpen] = useState(false)
  const [modelCandidates, setModelCandidates] = useState<string[]>([])
  const [query, setQuery] = useState<RecordsQuery | null>(null)
  const [autoOn, setAutoOn] = useState(readAutoOn())
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoErr, setAutoErr] = useState("")
  const [lastAt, setLastAt] = useState(0)
  const [fresh, setFresh] = useState<Record<string, 1>>({})
  const [loadError, setLoadError] = useState<string | null>(null)

  const cachedRef = useRef<CallerState | null>(null)
  // 每个渲染同步一批最新值供 interval / 事件读取，避免闭包过期。
  const r = useRef<any>({})
  r.current = { data, records, filter, days, daysOpen, query, autoOn, autoBusy, autoErr, lastAt, active, tab }

  const snapshotQuery = (): RecordsQuery => ({ days: r.current.days.slice(), filter: { ...r.current.filter } })
  const dirty = () => Boolean(r.current.query) && !sameQuery(r.current.query, snapshotQuery())
  const autoBlock = () => (!r.current.autoOn ? "off" : r.current.daysOpen ? "days" : dirty() ? "dirty" : "")
  const canAuto = () =>
    r.current.active &&
    r.current.tab === "records" &&
    !document.hidden &&
    Boolean(r.current.records) &&
    Boolean(r.current.query) &&
    !r.current.autoBusy &&
    autoBlock() === ""

  async function fetchRecords(q: RecordsQuery): Promise<RecordsResult> {
    const res = await getRecords(q)
    setModelCandidates((prev) => {
      const copy = prev.slice()
      ;(res.byModel || []).forEach((m: any) => {
        if (m && m.model && copy.indexOf(m.model) < 0) copy.push(m.model)
      })
      return copy
    })
    return res
  }

  async function loadState() {
    const d = await getState()
    setData(d)
    cachedRef.current = d
    if (r.current.days.length === 0) setDays(d.usage && d.usage.day ? [d.usage.day] : [])
  }
  async function loadRecords() {
    const q = snapshotQuery()
    const res = await fetchRecords(q)
    if (q.days.length === 0 && Array.isArray(res.days)) {
      q.days = res.days.slice()
      if (r.current.days.length === 0) setDays(res.days.slice())
    }
    setRecords(res)
    setQuery(q)
    setFresh({})
    setAutoErr("")
    setLastAt(Date.now())
  }

  async function refresh(which?: "state" | "records") {
    setLoadError(null)
    try {
      const jobs: Promise<any>[] = []
      if (which !== "records") jobs.push(loadState())
      if (which !== "state") jobs.push(loadRecords())
      await Promise.all(jobs)
    } catch (err: any) {
      setLoadError(String(err?.message ?? err))
    }
  }

  const toggleDay = (day: string) =>
    setDays((prev) => {
      const arr = prev.slice()
      const i = arr.indexOf(day)
      if (i >= 0) arr.splice(i, 1)
      else arr.push(day)
      return arr.sort().reverse().slice(0, 31)
    })

  const applyPreset = (kind: string) => {
    const s = presetSet(kind, (r.current.records && r.current.records.availableDays) || [])
    if (s === null) return
    setDays(s.slice(0, 31).sort().reverse())
  }

  const toggleAuto = () =>
    setAutoOn((prev) => {
      const next = !prev
      writeAutoOn(next)
      if (next) setLastAt(0)
      return next
    })

  const recordsSig = (res: any) => {
    const rows = (res && res.rows) || []
    return [
      res && res.total,
      res && res.shown,
      rows.length ? recKey(rows[0]) : "",
      rows.length ? recKey(rows[rows.length - 1]) : "",
      ((res && res.byModel) || []).map((m: any) => m.model + ":" + m.calls + ":" + m.errors).join(","),
    ].join("~")
  }

  async function autoTick() {
    if (!canAuto() || Date.now() - r.current.lastAt < autoMs()) return
    const q = r.current.query
    setAutoBusy(true)
    try {
      const res = await fetchRecords(q)
      setAutoErr("")
      if (recordsSig(res) === recordsSig(r.current.records)) {
        setRecords(res)
        return
      }
      const before: Record<string, 1> = {}
      ;((r.current.records && r.current.records.rows) || []).forEach((x: any) => {
        before[recKey(x)] = 1
      })
      const freshMap: Record<string, 1> = {}
      ;(res.rows || []).forEach((x: any) => {
        const k = recKey(x)
        if (!before[k]) freshMap[k] = 1
      })
      setRecords(res)
      setFresh(freshMap)
    } catch (err: any) {
      setAutoErr(String(err?.message ?? err))
    } finally {
      setAutoBusy(false)
      setLastAt(Date.now())
    }
  }
  const autoTickRef = useRef<() => void>(() => {})
  autoTickRef.current = autoTick

  // 打开视图：有缓存先画，随后并行刷新 state + records。
  useEffect(() => {
    if (!active) return
    if (cachedRef.current && !r.current.data) setData(cachedRef.current)
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // 1 秒 tick：驱动自动刷新 + 相对秒数重绘。
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => autoTickRef.current(), 1000)
    const onVis = () => {
      if (!document.hidden) autoTickRef.current()
    }
    document.addEventListener("visibilitychange", onVis)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [active])

  return {
    data,
    records,
    filter,
    setFilter,
    days,
    daysOpen,
    setDaysOpen,
    toggleDay,
    applyPreset,
    modelCandidates,
    query,
    autoOn,
    autoBusy,
    autoErr,
    lastAt,
    fresh,
    loadError,
    refresh,
    toggleAuto,
    autoBlock,
    autoMs,
    setDays,
  }
}
