/** 与框架无关的请求工具（cookie/IP/HTTPS 判定）。 */

export function parseCookies(header: any): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  if (typeof header !== "string" || header === "") return out
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (name === "") continue
    out[name] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

/** 来源 IP：只看 TCP 对端地址（刻意不信 X-Forwarded-For，防伪造绕过限速）。 */
export function clientIp(request: any) {
  return request.socket?.remoteAddress ?? "unknown"
}

/** 是否 HTTPS（只看连接本身，不信 X-Forwarded-Proto）。 */
export function isSecureRequest(request: any) {
  return request.socket?.encrypted === true
}
