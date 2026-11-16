/** OAuth 回调中继的纯逻辑：解析/还原回环回调地址，及允许的回环范围。 */

export const HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])
export const MIN_PORT = 1024
export const MAX_PORT = 65535

/** 解析 "http://127.0.0.1:41451/auth/callback?code=.." 或裸 "127.0.0.1:41451/..."。 */
export function parseLoopbackUrl(raw: any) {
  if (typeof raw !== "string") return null
  const text = raw.trim()
  if (text === "") return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (!HOSTS.has(url.hostname)) return null
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null
  return { host: url.hostname, port, path: url.pathname || "/", search: url.search || "", href: url.href }
}

/** 把 https://host/relay/<port>/... 还原成 loopback 地址。 */
export function loopbackOf(parsed: any) {
  return `http://${parsed.host}:${parsed.port}${parsed.path}${parsed.search}`
}
