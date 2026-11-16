import { useEffect, useRef, useState } from "react"

import { ago } from "../utils/time"

const API = "/admin/dashboard/api"
const REFRESH_MS = 30000

/**
 * 总览数据层：拉取快照、30s 轮询、手动刷新。让 Overview 视图保持“只渲染”。
 */
export function useOverviewData(active: boolean) {
  const [snapshot, setSnapshot] = useState<any>(null)
  const [summary, setSummary] = useState("加载中…")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  async function load(fresh: boolean) {
    try {
      const res = await fetch(API + (fresh ? "?fresh=1" : ""), { headers: { accept: "application/json" } })
      if (!res.ok) throw new Error("HTTP " + res.status)
      const data = await res.json()
      setSnapshot(data)
      setError(null)
      setSummary("快照 " + ago(data.generatedAt) + " · 每 30 秒自动刷新 · 余额最多缓存 5 分钟，数据全部读本机文件")
    } catch (err: any) {
      setError(String(err?.message ?? err))
      setSummary("加载失败：" + String(err?.message ?? err))
    }
  }

  useEffect(() => {
    if (!active) return
    load(false)
    if (timer.current === null) {
      timer.current = window.setInterval(() => {
        if (document.visibilityState === "visible" && activeRef.current) load(false)
      }, REFRESH_MS)
    }
    return () => {
      if (timer.current !== null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  async function refresh() {
    setBusy(true)
    try {
      await load(true)
    } finally {
      setBusy(false)
    }
  }

  return { snapshot, summary, error, busy, refresh }
}
