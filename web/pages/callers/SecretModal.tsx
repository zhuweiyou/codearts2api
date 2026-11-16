import clsx from "clsx"
import styles from "./SecretModal.module.less"
import { useEffect, useRef, useState } from "react"

import { copyText, selectAllText } from "../../utils/clipboard"

/**
 * 新建 Key 后的明文弹窗（明文只显示一次）。Esc 不关闭，只提示先复制，避免手快丢 Key。
 */
export function SecretModal({ secret, onClose }: { secret: string; onClose: () => void }) {
  const secretRef = useRef<HTMLDivElement | null>(null)
  const [copied, setCopied] = useState(false)
  const [hint, setHint] = useState("")

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Esc") return
      e.preventDefault()
      e.stopPropagation()
      setCopied(false)
      setHint("这串 Key 只显示一次，请先复制再点「关闭」。")
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [])

  const doCopy = () => {
    copyText(secret)
      .then(() => {
        setCopied(true)
        setHint("已复制到剪贴板。关掉这个窗口后就再也看不到这串 Key 了。")
      })
      .catch(() => {
        selectAllText(secretRef.current)
        setCopied(false)
        setHint("当前浏览器不允许自动复制（http 页面常见），已帮你全选，请按 Ctrl+C（Mac 为 ⌘+C）手动复制。")
      })
  }

  return (
    <div className="dim-jh-modalOverlay" style={{ zIndex: 3300 }}>
      <div
        role="dialog"
        aria-modal="true"
        className={clsx("dim-jh-modal", styles.scope)}
        style={{ width: "min(560px,calc(100vw - 24px))" }}
      >
        <div className="dim-jh-modalHead">
          <div className="dim-jh-modalTitle">
            <strong>新 Key 已创建</strong>
            <span className="dim-jh-modalSubtitle">这串明文只显示这一次</span>
          </div>
        </div>
        <div className="dim-jh-modalBody">
          <p className="dim-jh-modalHint">
            复制给调用方，关掉就再也看不到了（服务端只存哈希）。点一下下面这串可以全选。
          </p>
          <div className={styles.secret} ref={secretRef} onClick={() => selectAllText(secretRef.current)}>
            {secret}
          </div>
          <div className={styles.copyhint} data-ok={copied ? "1" : undefined}>
            {hint}
          </div>
          <div className={styles.row}>
            <button type="button" className="dim-jh-btn" onClick={doCopy}>
              复制 Key
            </button>
            <button type="button" className="dim-jh-btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
