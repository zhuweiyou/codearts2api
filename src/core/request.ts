/** 与框架无关的请求工具（cookie/IP/HTTPS 判定）。 */

/** 来源 IP：只看 TCP 对端地址（刻意不信 X-Forwarded-For，防伪造绕过限速）。 */
export function clientIp(request: any) {
  return request.socket?.remoteAddress ?? "unknown"
}

/** 是否 HTTPS（只看连接本身，不信 X-Forwarded-Proto）。 */
export function isSecureRequest(request: any) {
  return request.socket?.encrypted === true
}
