/** 管理端鉴权中间件：挂在受保护路由上，未授权则 302（浏览器）/401（脚本）；Bearer 猜密钥计入限速。 */
import { clientIp } from "../core/request.ts"
import { isAdminAuthorized } from "../modules/auth/auth.service.ts"
import { respondUnauthorized, sendAdminJson } from "./security.ts"

export function createAdminGuard({ adminKeyEnabled, adminKey, throttle }: any) {
  return (request: any, response: any, next: any) => {
    if (!adminKeyEnabled()) return next()
    if (isAdminAuthorized(request, adminKey)) return next()

    const authorization = String(request.headers?.authorization ?? "")
    if (authorization.startsWith("Bearer ")) {
      const ip = clientIp(request)
      throttle.fail(ip)
      const limited = throttle.check(ip)
      if (limited !== null) {
        sendAdminJson(response, 429, { error: `尝试过于频繁，请 ${limited.retryAfter} 秒后再试。` })
        return
      }
    }

    const url = new URL(request.originalUrl ?? request.url ?? "/", `http://${request.headers?.host ?? "127.0.0.1"}`)
    respondUnauthorized(request, response, url)
  }
}
