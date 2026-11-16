import { useEffect, useState } from "react"

import { replayOAuthCallback } from "../api/oauth-relay"
import { isReplayableUrl, loopbackFromRelay } from "../utils/oauth-relay"
import styles from "./OAuthRelayFix.module.less"

/**
 * 顶栏「回调修复」：远程部署时 OAuth 回调打到本机 127.0.0.1。
 * 粘贴浏览器里那条失败的回调地址（loopback 或 /relay/<port>/… 均可），由服务器在本机重放一次。
 * 自动改写 window.open / 页面链接的逻辑在 utils/oauth-relay.ts（main.tsx 里安装）。
 */
export function OAuthRelayFix() {
  const [open, setOpen] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  const valid = callbackUrl.trim() !== "" && isReplayableUrl(callbackUrl)

  function close() {
    if (busy) return
    setOpen(false)
    setCallbackUrl("")
    setResult(null)
    setHint(null)
  }

  // Esc 关闭（弹窗打开时）
  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, busy])

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      setCallbackUrl(text.trim())
      setHint(null)
    } catch {
      setHint("读取剪贴板失败，请手动粘贴。")
    }
  }

  async function submit() {
    const target = callbackUrl.trim()
    if (!target || busy) return
    if (!isReplayableUrl(target)) {
      setHint("只接受本机回调地址：http://127.0.0.1:<端口>/…、http://localhost:<端口>/… 或 /relay/<端口>/…")
      return
    }
    // 统一还原成 loopback 地址再交给重放接口
    const loopback = loopbackFromRelay(target, window.location.origin)
    setBusy(true)
    setResult(null)
    setHint(null)
    try {
      const data = await replayOAuthCallback(loopback)
      const snippet = data.snippet ? "；响应片段：" + data.snippet.slice(0, 160) : ""
      setResult({ ok: true, text: `已重放，本机端口 ${data.port} 返回状态 ${data.status ?? "?"}${snippet}` })
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="c2a-btn c2a-btn--ghost"
        id="c2a-oauth-relay"
        title="回调修复：把浏览器里失败的 OAuth 回调地址交给服务器本机重放"
        onClick={() => setOpen(true)}
      >
        回调修复
      </button>
      {open ? (
        <div
          className="c2a-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close()
          }}
        >
          <div className="c2a-modal" role="dialog" aria-modal="true" aria-label="回调修复">
            <div className="c2a-modal-head">
              <h3 className="c2a-modal-title">
                回调修复
                <span className="c2a-modal-sub">
                  远程部署时 OAuth 回调打到了本机 127.0.0.1。粘贴浏览器里那条失败的回调地址（loopback 或 /relay/…
                  均可）， 由服务器在本机重放一次。
                </span>
              </h3>
            </div>
            <div className="c2a-modal-body">
              <textarea
                className={styles.input}
                placeholder="https://你的域名/relay/19283/...   或   http://127.0.0.1:19283/..."
                value={callbackUrl}
                spellCheck={false}
                rows={4}
                onChange={(event) => {
                  setCallbackUrl(event.target.value)
                  setHint(null)
                }}
              />
              <div className={styles.toolbar}>
                <button type="button" className="c2a-btn c2a-btn--ghost" onClick={pasteFromClipboard}>
                  从剪贴板粘贴
                </button>
                {callbackUrl.trim() !== "" ? (
                  <span className={valid ? styles.okHint : styles.errHint}>
                    {valid ? "地址格式可用" : "格式不对：需本机回调或 /relay/ 地址"}
                  </span>
                ) : null}
              </div>
              {hint ? <div className={styles.err}>{hint}</div> : null}
              {result ? <div className={result.ok ? styles.ok : styles.err}>{result.text}</div> : null}
            </div>
            <div className="c2a-modal-foot">
              <button type="button" className="c2a-btn c2a-btn--ghost" onClick={close} disabled={busy}>
                关闭
              </button>
              <button type="button" className="c2a-btn c2a-btn--primary" onClick={submit} disabled={busy || !valid}>
                {busy ? "重放中…" : "重放"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
