import clsx from "clsx"
import styles from "./Callers.module.less"
import { useEffect, useRef, useState } from "react"

export interface FormField {
  key: string
  label: string
  type?: "text" | "textarea" | "select"
  value?: string
  options?: { value: string; label: string }[]
  hint?: string
}

/**
 * 新建/编辑分组与 Key 的表单弹窗。默认点遮罩不关，只认「取消/确定/Esc」（与旧行为一致，
 * 可设 window.__c2FormBackdropClose=true 恢复点遮罩关闭）。
 */
export function FormModal({
  title,
  fields,
  onOk,
  onClose,
}: {
  title: string
  fields: FormField[]
  onOk: (values: Record<string, string>) => Promise<void>
  onClose: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    fields.forEach((f) => {
      init[f.key] = f.value ?? (f.type === "select" ? (f.options?.[0]?.value ?? "") : "")
    })
    return init
  })
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null)
  const downOnBackdrop = useRef(false)

  useEffect(() => {
    const el = firstRef.current
    if (el) {
      el.focus()
      try {
        const n = (el as HTMLInputElement).value.length
        ;(el as HTMLInputElement).setSelectionRange(n, n)
      } catch {
        /* ignore */
      }
    }
  }, [])

  const submit = async () => {
    setErr("")
    setBusy(true)
    try {
      await onOk(values)
      onClose()
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="dim-jh-modalOverlay"
      style={{ zIndex: 3200 }}
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        const clean = downOnBackdrop.current
        downOnBackdrop.current = false
        if (clean && e.target === e.currentTarget && (window as any).__c2FormBackdropClose === true) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={clsx("dim-jh-modal", styles.scope)}
        data-scope="c2m"
        style={{ width: "min(520px,calc(100vw - 24px))" }}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "Esc") {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <div className="dim-jh-modalHead">
          <div className="dim-jh-modalTitle">
            <strong>{title}</strong>
          </div>
        </div>
        <div className="dim-jh-modalBody">
          <div className={styles.form}>
            {fields.map((f, i) => (
              <div key={f.key}>
                <label>{f.label}</label>
                {f.type === "textarea" ? (
                  <textarea
                    ref={i === 0 ? (firstRef as any) : undefined}
                    rows={3}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                ) : f.type === "select" ? (
                  <select
                    ref={i === 0 ? (firstRef as any) : undefined}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  >
                    {(f.options || []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    ref={i === 0 ? (firstRef as any) : undefined}
                    type="text"
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                )}
                {f.hint ? <div className={clsx(styles.muted, "c2a-text-2xs")}>{f.hint}</div> : null}
              </div>
            ))}
            <div className={styles.err}>{err}</div>
          </div>
          <div className={styles.row}>
            <span className={styles.rowhint}>Esc 或「取消」关闭</span>
            <button type="button" className="dim-jh-btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="dim-jh-btn"
              style={{
                borderColor: "var(--dsw-alias-brand-primary,#1677ff)",
                color: "var(--dsw-alias-brand-primary,#1677ff)",
              }}
              onClick={submit}
              disabled={busy}
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
