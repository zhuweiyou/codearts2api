import { useEffect, useState } from "react"
import { createPortal } from "react-dom"

import styles from "./MobileProviderPicker.module.less"

interface ProviderItem {
  id: string
  label: string
  icon: string
  selected: boolean
}

function readProviders(): ProviderItem[] {
  return Array.from(document.querySelectorAll(".dim-jh-railScroll .dim-jh-providerRow[data-provider]")).map((row) => {
    const button = row.querySelector<HTMLButtonElement>("button.dim-jh-provider")
    const label =
      row.querySelector(".dim-jh-providerLabel strong")?.textContent?.trim() || row.getAttribute("data-provider") || ""
    const icon = row.querySelector<HTMLImageElement>("img")?.src || ""
    return {
      id: row.getAttribute("data-provider") || "",
      label,
      icon,
      selected: button?.getAttribute("aria-selected") === "true",
    }
  })
}

/**
 * 窄屏下上游 provider rail 会变成横向滚动条，操作起来很别扭。
 * 手机端改成「当前渠道按钮 + 左侧抽屉」：桌面宽度完全不介入上游布局。
 */
export function MobileProviderPicker() {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<ProviderItem[]>([])

  useEffect(() => {
    let el: HTMLDivElement | null = null
    const ensure = () => {
      const rail = document.querySelector(".dim-jh-rail")
      if (!rail) return
      if (el && rail.contains(el)) return
      if (!el) {
        el = document.createElement("div")
        el.className = "c2a-mobile-provider"
      }
      rail.insertBefore(el, rail.firstChild)
      setHost(el)
    }
    ensure()
    const observer = new MutationObserver(() => ensure())
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (el && el.parentNode) el.parentNode.removeChild(el)
    }
  }, [])

  useEffect(() => {
    const sync = () => setProviders(readProviders())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected", "data-provider"],
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const current = providers.find((provider) => provider.selected)

  const selectProvider = (id: string) => {
    const row = Array.from(document.querySelectorAll(".dim-jh-railScroll .dim-jh-providerRow[data-provider]")).find(
      (item) => item.getAttribute("data-provider") === id,
    )
    row?.querySelector<HTMLButtonElement>("button.dim-jh-provider")?.click()
    setOpen(false)
  }

  if (!host) return null

  return (
    <>
      {createPortal(
        <button
          type="button"
          className={styles.trigger}
          aria-label="选择渠道"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {current?.icon ? <img className={styles.triggerIcon} src={current.icon} alt="" /> : null}
          <span className={styles.triggerLabel}>{current?.label || "选择渠道"}</span>
          <span className={styles.triggerArrow} aria-hidden="true">
            ▾
          </span>
        </button>,
        host,
      )}
      {open
        ? createPortal(
            <div
              className={styles.backdrop}
              onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}
            >
              <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="选择渠道">
                <div className={styles.head}>
                  <strong>选择渠道</strong>
                  <button type="button" className={styles.close} aria-label="关闭" onClick={() => setOpen(false)}>
                    ×
                  </button>
                </div>
                <div className={styles.list}>
                  {providers.length === 0 ? (
                    <div className={styles.empty}>渠道加载中…</div>
                  ) : (
                    providers.map((provider) => (
                      <button
                        key={provider.id}
                        type="button"
                        className={styles.item}
                        data-selected={provider.selected ? "true" : "false"}
                        onClick={() => selectProvider(provider.id)}
                      >
                        {provider.icon ? <img className={styles.icon} src={provider.icon} alt="" /> : null}
                        <span className={styles.label}>{provider.label}</span>
                        {provider.selected ? (
                          <span className={styles.check} aria-hidden="true">
                            ✓
                          </span>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              </aside>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
