/** 宿主：在渠道面板顶部挂「账号管理 / 可用模型」两个 Tab，模型面板默认隐藏。 */
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { ModelsPanel } from "./ModelsPanel"
import styles from "./ModelsPanelHost.module.less"

type Tab = "account" | "models"

const TAB_META: Array<{ id: Tab; label: string }> = [
  { id: "account", label: "账号管理" },
  { id: "models", label: "可用模型" },
]

function directAccountSection(panel: HTMLElement): HTMLElement | null {
  return Array.from(panel.children).find((child) =>
    child.classList.contains("dim-jh-accountSection"),
  ) as HTMLElement | null
}

function selectedProviderId(): string {
  const button = document.querySelector<HTMLButtonElement>(
    '.dim-jh-providerRow[data-provider] button.dim-jh-provider[aria-selected="true"]',
  )
  return button?.closest<HTMLElement>(".dim-jh-providerRow[data-provider]")?.getAttribute("data-provider") || ""
}

export function ModelsPanelHost() {
  const [tabHost, setTabHost] = useState<HTMLDivElement | null>(null)
  const [modelHost, setModelHost] = useState<HTMLDivElement | null>(null)
  const [active, setActive] = useState<Tab>("account")
  const activeRef = useRef<Tab>("account")
  const providerRef = useRef("")

  activeRef.current = active

  useEffect(() => {
    let tabEl: HTMLDivElement | null = null
    let modelEl: HTMLDivElement | null = null

    const sync = () => {
      const panel = document.querySelector<HTMLElement>("main.dim-jh-panel")
      if (!panel) return
      const account = directAccountSection(panel)

      // 切换渠道时回到默认的账号管理 Tab。
      const provider = selectedProviderId()
      if (provider !== providerRef.current) {
        providerRef.current = provider
        activeRef.current = "account"
        setActive("account")
      }

      // 聚合等没有账号区的面板不显示这两个 Tab，保持模型面板原行为。
      const showTabs = account !== null
      // Tab 栏固定时由面板内部的内容区滚动，禁止整块 panel 自己滚，
      // 否则滚动会把 Tab 顶到内容上方（移动端会看到列表行从 Tab 上方穿出）。
      panel.style.overflow = showTabs ? "hidden" : ""
      if (tabEl) tabEl.style.display = showTabs ? "" : "none"
      if (account) account.style.display = activeRef.current === "models" ? "none" : ""
      if (modelEl) modelEl.style.display = showTabs && activeRef.current === "models" ? "" : "none"
    }

    const ensure = () => {
      const panel = document.querySelector<HTMLElement>("main.dim-jh-panel")
      if (!panel) return
      if (!tabEl) {
        tabEl = document.createElement("div")
        tabEl.setAttribute("data-c2a-tabs", "1")
        tabEl.className = styles.tabsHost
      }
      if (!modelEl) {
        modelEl = document.createElement("div")
        modelEl.setAttribute("data-c2a-models", "1")
        modelEl.className = styles.modelsHost
        modelEl.style.display = "none"
      }
      if (tabEl.parentElement !== panel) panel.insertBefore(tabEl, panel.firstChild)
      if (modelEl.parentElement !== panel) panel.insertBefore(modelEl, tabEl.nextSibling)
      setTabHost(tabEl)
      setModelHost(modelEl)
      sync()
    }

    ensure()
    const observer = new MutationObserver(() => ensure())
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    })
    return () => {
      observer.disconnect()
      tabEl?.remove()
      modelEl?.remove()
    }
  }, [])

  useEffect(() => {
    const panel = document.querySelector<HTMLElement>("main.dim-jh-panel")
    if (!panel) return
    const account = directAccountSection(panel)
    panel.style.overflow = account !== null ? "hidden" : ""
    if (account) account.style.display = active === "models" ? "none" : ""
    if (modelHost) modelHost.style.display = account !== null && active === "models" ? "" : "none"
  }, [active, modelHost])

  return (
    <>
      {tabHost
        ? createPortal(
            <div className={styles.tabs} role="tablist" aria-label="账号管理与可用模型">
              {TAB_META.map((item) => (
                <div key={item.id} className={styles.tabItem} onClick={() => setActive(item.id)}>
                  <button type="button" role="tab" className={styles.tab} aria-selected={active === item.id}>
                    {item.label}
                  </button>
                </div>
              ))}
            </div>,
            tabHost,
          )
        : null}
      {modelHost ? createPortal(<ModelsPanel />, modelHost) : null}
    </>
  )
}
