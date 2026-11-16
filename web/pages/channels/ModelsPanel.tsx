/**
 * 模型面板 —— 纯 React 组件（样式用 CSS Modules：models.module.css），注入上游「渠道管理」右侧 `.dim-jh-panel`。
 * 上游页为第三方 React bundle，无法直接嵌入其组件树，故用 createPortal 挂进 `.dim-jh-panel` 的宿主 div。
 */
import clsx from "clsx"
import { useEffect, useRef, useState } from "react"

import styles from "./ModelsPanel.module.less"

const API = "/admin/models/api"

interface Provider {
  id: string
  label: string
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n)
}
function fmtReset(ts: any): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return ""
  const d = new Date(ts)
  const now = new Date()
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes())
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate())
    return hm
  return d.getMonth() + 1 + "/" + d.getDate() + " " + hm
}
function stateText(m: any): string {
  if (m.state === "dead") return "已下架"
  if (m.state === "off") return "已关闭"
  if (m.state === "limited") return "全部限流"
  if (m.state === "partial") return "部分限流"
  return "可用"
}
function currentProvider(): Provider | null {
  const btn = document.querySelector('.dim-jh-providerRow[data-provider] button.dim-jh-provider[aria-selected="true"]')
  if (!btn) return null
  const row = btn.closest(".dim-jh-providerRow[data-provider]")
  if (!row) return null
  const id = row.getAttribute("data-provider")
  if (!id) return null
  const label = btn.querySelector(".dim-jh-providerLabel strong")
  return { id, label: label && label.textContent ? label.textContent : id }
}
async function post<T = any>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data && (data as any).error) || "HTTP " + r.status)
  return data as T
}
function visibleModels(data: any, q: string, filter: string): any[] {
  const query = q.trim().toLowerCase()
  return (data.models || []).filter((m: any) => {
    if (query.length > 0) {
      const hay = (String(m.id || "") + " " + String(m.name || "")).toLowerCase()
      if (hay.indexOf(query) < 0) return false
    }
    if (filter === "usable") return m.state === "ok" || m.state === "partial"
    if (filter === "limited") return m.state === "limited" || m.state === "partial"
    if (filter === "off") return m.state === "off" || m.state === "dead"
    return true
  })
}

export function ModelsPanel() {
  const [provider, setProvider] = useState<Provider | null>(() => currentProvider())
  const [data, setData] = useState<any>(null)
  const [open, setOpen] = useState(true)
  const [q, setQ] = useState("")
  const [filter, setFilter] = useState("all")
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [err, setErr] = useState<string | null>(null)
  const providerIdRef = useRef<string>("")
  providerIdRef.current = provider ? provider.id : ""

  useEffect(() => {
    const sync = () => {
      const p = currentProvider()
      setProvider((prev) => {
        if (!p) return prev
        if (prev && prev.id === p.id && prev.label === p.label) return prev
        return p
      })
    }
    const obs = new MutationObserver(sync)
    obs.observe(document.body, { attributes: true, attributeFilter: ["aria-selected"], subtree: true, childList: true })
    sync()
    return () => obs.disconnect()
  }, [])

  const load = async (id: string) => {
    try {
      const res = await post({ action: "overview", provider: id })
      if (providerIdRef.current !== id) return
      setData(res)
      setErr(null)
    } catch (e: any) {
      if (providerIdRef.current === id) setErr(String(e?.message ?? e))
    }
  }

  useEffect(() => {
    if (!provider) return
    setData(null)
    setQ("")
    setFilter("all")
    load(provider.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  useEffect(() => {
    if (!provider) return
    const id = provider.id
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load(id)
    }, 30000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  if (!provider) return null

  const counts = (data && data.counts) || { total: 0, usable: 0, partial: 0, limited: 0, off: 0, dead: 0 }
  const rows = data ? visibleModels(data, q, filter) : []

  const onToggle = async (m: any) => {
    const id = provider.id
    const key = id + "\u0000" + m.id
    if (busy[key]) return
    const nextDisabled = !m.disabled
    setBusy((b) => ({ ...b, [key]: true }))
    try {
      await post({ action: "toggle", provider: id, modelId: m.id, disabled: nextDisabled })
      await load(id)
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    } finally {
      setBusy((b) => {
        const n = { ...b }
        delete n[key]
        return n
      })
    }
  }

  const tabs: { id: string; label: string; n: number }[] = [
    { id: "usable", label: "可用", n: counts.usable },
    { id: "limited", label: "限流", n: counts.limited + counts.partial },
    { id: "off", label: "已关闭", n: counts.off + counts.dead },
    { id: "all", label: "全部", n: counts.total },
  ]

  return (
    <section className={styles.section} data-c2a-section={provider.id}>
      <div className={styles.head}>
        <h3 className={styles.title}>{provider.label} 可用模型</h3>
        <span className={styles.sub}>
          {counts.usable}/{counts.total} 个可用
        </span>
        <div className={styles.tools}>
          <input
            type="text"
            placeholder="筛选模型…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={styles.tab}
              aria-pressed={filter === t.id ? "true" : "false"}
              onClick={() => setFilter(t.id)}
            >
              {t.label} <span className={styles.t}>{t.n}</span>
            </button>
          ))}
          <button type="button" className={styles.icon} title="刷新" onClick={() => load(provider.id)}>
            ↻
          </button>
          <button
            type="button"
            className={styles.icon}
            title={open ? "折叠" : "展开"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▲" : "▼"}
          </button>
        </div>
      </div>
      {open ? (
        <>
          <div className={styles.sum}>
            <span className={styles.ok}>
              可用 <b>{counts.usable}</b>
            </span>
            <span className={styles.warn}>
              部分限流 <b>{counts.partial}</b>
            </span>
            <span className={styles.bad}>
              全部限流 <b>{counts.limited}</b>
            </span>
            <span className={styles.mute}>
              已关闭 <b>{counts.off}</b>
            </span>
            <span className={styles.mute}>
              已下架 <b>{counts.dead}</b>
            </span>
            <span className={styles.mute}>
              共 <b>{counts.total}</b>
            </span>
          </div>
          <div className={styles.scroll}>
            {!data ? (
              <div className={styles.empty}>加载中…</div>
            ) : rows.length === 0 ? (
              <div className={styles.empty}>没有匹配的模型</div>
            ) : (
              rows.map((m: any) => {
                const key = provider.id + "\u0000" + m.id
                const isBusy = !!busy[key]
                const reset = m.nextResetAt !== null && m.nextResetAt !== undefined ? fmtReset(m.nextResetAt) : ""
                const accText =
                  m.enabledAccounts > 0 ? m.usableAccounts + "/" + m.enabledAccounts + " 号可用" : "无账号"
                return (
                  <div key={m.id} className={styles.mrow} data-state={m.state} data-model={m.id}>
                    <span className={styles.dot} />
                    <span className={styles.name} title={m.name || m.id}>
                      {m.name || m.id}
                    </span>
                    <code className={styles.id} title={m.id}>
                      {m.id}
                    </code>
                    <span className={clsx(styles.tag, styles[m.state])}>{stateText(m)}</span>
                    {reset ? (
                      <span className={styles.reset} title="限额重置时间">
                        {reset}
                      </span>
                    ) : null}
                    <span className={styles.acc} title="已启用账号中还能用该模型的比例">
                      {accText}
                    </span>
                    <button
                      type="button"
                      className={styles.sw}
                      role="switch"
                      aria-checked={m.disabled ? "false" : "true"}
                      aria-label={(m.name || m.id) + " 是否启用"}
                      disabled={isBusy}
                      onClick={() => onToggle(m)}
                    />
                  </div>
                )
              })
            )}
          </div>
          {data && data.accountsError ? (
            <div className={styles.err}>{data.accountsError} —— 限流状态不可信，请刷新重试</div>
          ) : null}
          {err ? <div className={styles.err}>{err}</div> : null}
          <div className={styles.note}>
            「可用」＝ 至少还有一个已启用账号没被该模型限流；「全部限流」＝ 所有已启用账号都在重置窗口内。关闭开关后下游{" "}
            <code>/v1/models</code> 不再列出该模型。
          </div>
        </>
      ) : null}
    </section>
  )
}
