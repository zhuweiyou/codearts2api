/** 全屏登录页（未登录时由 AuthGate 展示）。 */
import { useState } from "react"

import { login } from "../api/auth"
import styles from "./Login.module.less"

/** 直接访问 /admin/xxx 时没有 ?next=，用当前地址作为登录后的回跳目标。 */
function fallbackNext(): string {
  const current = window.location.pathname + window.location.search
  if (/^\/admin\/login(?:[/?]|$)/.test(current)) return "/admin/overview"
  return current || "/admin/overview"
}

export function Login({ onSuccess }: { onSuccess: (next: string) => void }) {
  const [key, setKey] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const next = new URLSearchParams(window.location.search).get("next") || fallbackNext()

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await login(key.trim(), next)
      onSuccess(result.next || next)
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={submit}>
        <h1 className={styles.title}>
          <span className={styles.mark} aria-hidden="true" />
          codearts2api
        </h1>
        <p className={styles.sub}>管理后台需要访问密钥</p>
        {error ? <p className={styles.error}>{error}</p> : null}
        <label className={styles.label} htmlFor="c2a-key">
          访问密钥
        </label>
        <input
          id="c2a-key"
          className={styles.input}
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          autoFocus
          required
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <button className={styles.button} type="submit" disabled={busy}>
          {busy ? "登录中…" : "进入后台"}
        </button>
      </form>
    </div>
  )
}
