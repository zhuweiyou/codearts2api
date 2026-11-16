/** 复制到剪贴板：安全上下文用异步 API，否则回退 textarea + execCommand。 */
export function copyText(text: string): Promise<void> {
  const value = String(text ?? "")
  return new Promise((resolve, reject) => {
    const legacy = () => {
      let ta: HTMLTextAreaElement | null = null
      try {
        ta = document.createElement("textarea")
        ta.value = value
        ta.setAttribute("readonly", "")
        ta.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0"
        document.body.appendChild(ta)
        ta.select()
        ta.setSelectionRange(0, value.length)
        const ok = document.execCommand("copy")
        if (ok) resolve()
        else reject(new Error("execCommand('copy') 返回 false"))
      } catch (err) {
        reject(err)
      } finally {
        if (ta && ta.parentNode) ta.parentNode.removeChild(ta)
      }
    }
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(() => resolve(), legacy)
      return
    }
    legacy()
  })
}

/** 选中元素全部文本（复制失败的兜底）。 */
export function selectAllText(el: HTMLElement | null) {
  if (!el) return
  try {
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  } catch {
    /* ignore */
  }
}
