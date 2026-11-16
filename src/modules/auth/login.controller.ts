/**
 * 管理端登录/登出/会话 API。登录界面在前端（web/components/Login），后端只处理凭据与 Cookie。
 */
import express from "express"

import { sanitizeNext } from "../../core/safe-next.ts"
import { clientIp, isSecureRequest } from "../../core/request.ts"
import { sendJson } from "../../http/respond.ts"
import { constantTimeEquals, isSessionAuthorized, clearSessionCookie, sessionCookie } from "./auth.service.ts"

export function createAuthRouter({ adminKeyEnabled, adminKey, throttle, logger }: any) {
  const router = express.Router()

  router.get("/api/session", (request, response) => {
    // 这个接口是公开的：只认会话 Cookie。若接受 Bearer，会绕开 adminGuard 的
    // 失败限速，成为可以无限试管理密钥的探测口（见 auth.service 的说明）。
    const authenticated = adminKeyEnabled() ? isSessionAuthorized(request, adminKey) : true
    sendJson(response, 200, { authenticated })
  })

  router.post(
    "/login",
    express.json({ limit: "8kb" }),
    express.urlencoded({ extended: false, limit: "8kb" }),
    async (request, response) => {
      if (!adminKeyEnabled()) {
        sendJson(response, 200, { ok: true, next: "/admin/overview" })
        return
      }
      const ip = clientIp(request)
      const limited = throttle.check(ip)
      if (limited !== null) {
        sendJson(response, 429, { error: `尝试过于频繁，请 ${limited.retryAfter} 秒后再试。` })
        return
      }
      const body = request.body ?? {}
      const key = String(body.key ?? "")
      const next = sanitizeNext(String(body.next ?? ""))
      if (constantTimeEquals(key.trim(), adminKey)) {
        throttle.reset(ip)
        response.setHeader("set-cookie", sessionCookie(adminKey, { secure: isSecureRequest(request) }))
        sendJson(response, 200, { ok: true, next })
        return
      }
      throttle.fail(ip)
      logger?.warn?.(`[admin-auth] 登录失败 ip=${ip}`)
      sendJson(response, 401, { error: "访问密钥不正确，请重试。" })
    },
  )

  router.post("/logout", (_request, response) => {
    response.setHeader("set-cookie", clearSessionCookie())
    sendJson(response, 200, { ok: true })
  })

  // 登出会改变状态：只允许 POST，GET 明确 405，避免跨站图片/链接触发登出。
  router.get("/logout", (_request, response) => {
    sendJson(response, 405, { error: "method not allowed" })
  })

  return router
}
