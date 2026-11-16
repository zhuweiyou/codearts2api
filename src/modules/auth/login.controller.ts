/** 管理端登录/登出流程（表单登录 → 会话 Cookie），从 server.js 拆出。 */
import {
  LOGIN_PATH,
  clientIp,
  clearSessionCookie,
  constantTimeEquals,
  isAdminAuthorized,
  isSecureRequest,
  sessionCookie,
} from "./auth.service.ts"
import { renderLoginPage, sanitizeNext } from "./login-page.view.ts"
import { readLoginForm } from "../../http/body.ts"
import { SECURITY_HEADERS, sendAdmin, sendAdminJson } from "../../http/security.ts"

/**
 * @param adminKeyEnabled - () => boolean（鉴权是否生效）
 * @param adminKey - 当前管理密钥（可能 null）
 * @param throttle - 登录失败限速
 * @param logger
 */
export function createAdminLoginRoutes({ adminKeyEnabled, adminKey, throttle, logger }) {
  function respondLoginPage(request, response, url, error) {
    sendAdmin(
      response,
      200,
      renderLoginPage({
        error,
        next: sanitizeNext(url.searchParams.get("next") ?? "/admin"),
        disabled: !adminKeyEnabled(),
      }),
      { "content-type": "text/html; charset=utf-8" },
    )
  }

  async function handleLogin(request, response, url) {
    if (request.method === "GET" || request.method === "HEAD") {
      if (adminKeyEnabled() && isAdminAuthorized(request, adminKey)) {
        sendAdmin(response, 302, "", { location: sanitizeNext(url.searchParams.get("next") ?? "/admin") })
        return
      }
      respondLoginPage(request, response, url, null)
      return
    }
    if (request.method !== "POST") {
      sendAdminJson(response, 405, { error: "method not allowed" })
      return
    }

    const ip = clientIp(request)
    const limited = throttle.check(ip)
    if (limited !== null) {
      respondLoginPage(request, response, url, `尝试过于频繁，请 ${limited.retryAfter} 秒后再试。`)
      return
    }

    let form
    try {
      form = await readLoginForm(request)
    } catch {
      sendAdminJson(response, 400, { error: "invalid form body" })
      return
    }

    if (adminKeyEnabled() && constantTimeEquals(form.key.trim(), adminKey)) {
      throttle.reset(ip)
      const next = sanitizeNext(form.next)
      response.writeHead(303, {
        ...SECURITY_HEADERS,
        "cache-control": "no-store",
        "set-cookie": sessionCookie(adminKey, { secure: isSecureRequest(request) }),
        location: next,
      })
      response.end()
      return
    }

    throttle.fail(ip)
    logger?.warn?.(`[admin-auth] 登录失败 ip=${ip}`)
    respondLoginPage(request, response, url, "访问密钥不正确，请重试。")
  }

  function handleLogout(request, response) {
    response.writeHead(303, {
      ...SECURITY_HEADERS,
      "cache-control": "no-store",
      "set-cookie": clearSessionCookie(),
      location: LOGIN_PATH,
    })
    response.end()
  }

  return { handleLogin, handleLogout, respondLoginPage }
}
