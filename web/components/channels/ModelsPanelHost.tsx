/** 宿主：把 ModelsPanel 通过 portal 挂进上游 `.dim-jh-panel` 的第一个子节点；被移除时自动补回。 */
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"

import { ModelsPanel } from "./ModelsPanel"

export function ModelsPanelHost() {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    let el: HTMLDivElement | null = null
    const ensure = () => {
      const panel = document.querySelector("main.dim-jh-panel")
      if (!panel) return
      if (el && panel.contains(el)) return
      if (!el) {
        el = document.createElement("div")
        el.setAttribute("data-c2x-host", "1")
      }
      panel.insertBefore(el, panel.firstChild)
      setHost(el)
    }
    ensure()
    const obs = new MutationObserver(() => ensure())
    obs.observe(document.body, { childList: true, subtree: true })
    return () => {
      obs.disconnect()
      if (el && el.parentNode) el.parentNode.removeChild(el)
    }
  }, [])
  return host ? createPortal(<ModelsPanel />, host) : null
}
