/**
 * OAuth 中继工具（纯函数 + 浏览器副作用）。
 *
 * 背景：上游 provider 的回调服务器一律绑 127.0.0.1:<随机端口>，远程部署时浏览器打开
 * loopback 地址会 ERR_CONNECTION_REFUSED。后端有 `/relay/<port>/<path>` 反代；这里负责：
 *  1) 把 loopback URL 改写为 `<origin>/relay/<port>/<path>`（供 window.open / 页面链接）；
 *  2) 把用户可能粘贴的 relay 地址还原成 loopback（供「回调修复」重放接口使用）。
 *
 * 端口范围与后端 `src/oauth-relay.ts` 的 parseLoopbackUrl 保持一致：**1024–65535**。
 */

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})(\/[^\s]*)?$/i

/** 端口是否在后端允许范围（1024–65535）。 */
function isAllowedPort(portText: string): boolean {
  const port = Number(portText)
  return Number.isInteger(port) && port >= 1024 && port <= 65535
}

/** loopback URL → 本站 `/relay/<port>/<rest>`；非 loopback 或端口越界原样返回。 */
export function relayLoopbackUrl(raw: string, origin?: string): string {
  if (typeof raw !== "string" || raw === "") return raw
  const base = origin ?? (typeof location !== "undefined" ? location.origin : "")
  const match = LOOPBACK.exec(raw.trim())
  if (!match || !isAllowedPort(match[2])) return raw
  const rest = match[3] || "/"
  return base + "/relay/" + match[2] + rest
}

/** 本站 `/relay/<port>/<rest>` → `http://127.0.0.1:<port><rest>`；其它/越界原样返回。 */
export function loopbackFromRelay(raw: string, origin?: string): string {
  if (typeof raw !== "string") return raw
  const base = origin ?? (typeof location !== "undefined" ? location.origin : "")
  const text = raw.trim()
  const prefix = base.replace(/\/$/, "") + "/relay/"
  if (!text.startsWith(prefix)) return text
  const match = /^(\d{2,5})(\/.*)?$/.exec(text.slice(prefix.length))
  if (!match || !isAllowedPort(match[1])) return text
  return "http://127.0.0.1:" + match[1] + (match[2] || "/")
}

/** 校验输入是否是「可重放」的地址（端口合法范围内的 loopback，或本站 relay）。 */
export function isReplayableUrl(raw: string, origin?: string): boolean {
  const text = raw.trim()
  const m = LOOPBACK.exec(text)
  if (m && isAllowedPort(m[2])) return true
  return loopbackFromRelay(text, origin) !== text
}

/**
 * 安装浏览器端的自动中继（等价旧 UI 的 window.open 改写 + DOM 链接改写）。
 * 幂等；仅在浏览器环境执行。
 */
export function installOAuthRelay(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  const w = window as any
  if (w.__c2OAuthRelayLoaded) return
  w.__c2OAuthRelayLoaded = true

  w.__c2RelayOf = (raw: string) => relayLoopbackUrl(raw, window.location.origin)

  // 1) 改写 window.open：上游一律 window.open(loginUrl, "_blank", "width=800,height=600")
  const rawOpen = w.open ? w.open.bind(window) : null
  if (rawOpen) {
    w.open = function (url?: any, name?: any, features?: any) {
      try {
        return rawOpen(relayLoopbackUrl(String(url ?? ""), window.location.origin), name, features)
      } catch {
        return rawOpen(url, name, features)
      }
    }
  }

  const LOOPBACK_TEXT = /https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})(\/\S*)?/i

  const fixElement = (el: Element) => {
    const tag = el.tagName
    if (tag === "A") {
      const href = el.getAttribute("href") || ""
      const next = relayLoopbackUrl(href, window.location.origin)
      if (next !== href) {
        el.setAttribute("href", next)
        el.setAttribute("data-c2-relayed", "1")
      }
      return
    }
    if (tag === "CODE" || el.classList.contains("dim-jh-loginLink")) {
      const text = el.textContent || ""
      const next = relayLoopbackUrl(text, window.location.origin)
      if (next !== text) el.textContent = next
    }
  }

  // 处理「节点自身 + 其后代」里的 loopback 链接/文本；覆盖 addedNode 自身被替换成链接的情况
  const fixNode = (root: Node | null) => {
    if (!root) return
    if (root.nodeType === 1) fixElement(root as Element)
    const scope = root.nodeType === 1 ? (root as Element) : null
    scope?.querySelectorAll("a[href]").forEach(fixElement)
    scope?.querySelectorAll("code, .dim-jh-loginLink").forEach(fixElement)
  }

  // 文本节点原地更新：把命中 loopback 的文本节点也改写
  const fixTextNode = (node: Node) => {
    const text = node.textContent || ""
    if (!LOOPBACK_TEXT.test(text)) return
    const next = relayLoopbackUrl(text.trim(), window.location.origin)
    if (next !== text.trim()) node.textContent = next
  }

  const start = () => {
    fixNode(document.body)
    const observer = new MutationObserver((mutations) => {
      for (const mu of mutations) {
        if (mu.type === "characterData") {
          fixTextNode(mu.target)
          continue
        }
        mu.addedNodes.forEach((node) => {
          if (node.nodeType === 1) fixNode(node)
          else if (node.nodeType === 3) fixTextNode(node)
        })
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
}
