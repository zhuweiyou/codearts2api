/**
 * 管理端登录/登出/会话 API。登录界面在前端（web/components/Login），后端只处理凭据与 Cookie。
 */
import express from "express"

import { sanitizeNext } from "../../core/safe-next.ts"
import { clientIp, isSecureRequest } from "../../core/request.ts"
import { sendJson } from "../../http/respond.ts"
import { constantTimeEquals, isAdminAuthorized, clearSessionCookie, sessionCookie } from "./auth.service.ts"

export const AUTH_BASE = "/admin"
const SESSION_PATH = "/api/session"
const LOGIN_PATH = "/login"
const LOGOUT_PATH = "/logout"

const CREDENTIAL_LIMIT = 8 * 1024

async function readCredentials(request: any): Promise<{ key: string; next: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > CREDENTIAL_LIMIT) throw new Error("请求体过大")
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  const contentType = String(request.headers?.["content-type"] ?? "")
  if (contentType.includes("application/json")) {
    const body = text ? JSON.parse(text) : {}
    return { key: String(body.key ?? ""), next: String(body.next ?? "") }
  }
  const form = new URLSearchParams(text)
  return { key: String(form.get("key") ?? ""), next: String(form.get("next") ?? "") }
}

export function createAuthRouter({ adminKeyEnabled, adminKey, throttle, logger }: any) {
  const router = express.Router()

  router.get(SESSION_PATH, (request, response) => {
    const authenticated = adminKeyEnabled() ? isAdminAuthorized(request, adminKey) : true
    sendJson(response, 200, { authenticated })
  })

  router.post(LOGIN_PATH, async (request, response) => {
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
    let credentials: { key: string; next: string }
    try {
      credentials = await readCredentials(request)
    } catch {
      sendJson(response, 400, { error: "请求体不是合法 JSON/表单" })
      return
    }
    if (constantTimeEquals(credentials.key.trim(), adminKey)) {
      throttle.reset(ip)
      const next = sanitizeNext(credentials.next)
      response.setHeader("set-cookie", sessionCookie(adminKey, { secure: isSecureRequest(request) }))
      sendJson(response, 200, { ok: true, next })
      return
    }
    throttle.fail(ip)
    logger?.warn?.(`[admin-auth] 登录失败 ip=${ip}`)
    sendJson(response, 401, { error: "访问密钥不正确，请重试。" })
  })

  router.all(LOGOUT_PATH, (_request, response) => {
    response.setHeader("set-cookie", clearSessionCookie())
    sendJson(response, 200, { ok: true })
  })

  return router
}
