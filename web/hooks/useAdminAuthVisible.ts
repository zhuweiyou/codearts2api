import { useEffect, useState } from "react"

/**
 * 后端是否开启了管理端鉴权（`/healthz` 的 `adminAuth`）。
 * 返回 true 表示显示「退出」按钮；鉴权关闭时隐藏。
 */
export function useAdminAuthVisible(): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    let alive = true
    fetch("/healthz", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: any) => {
        if (alive && d && d.adminAuth === false) setVisible(false)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return visible
}
