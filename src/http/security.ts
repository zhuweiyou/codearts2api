/** 安全响应头、响应辅助函数、鉴权判定。与路由编排解耦，供各层复用。 */
import { LOGIN_PATH, LOGOUT_PATH } from "../admin-auth.ts"
import { CARRIER_PATH } from "../core/upstream.ts"

/**
 * 管理相关的安全响应头（CSP 按页面能力定：script-src 'self' / style 'unsafe-inline' /
 * img data: blob: / connect 'self'）。
 */
export const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
}

export const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
}

export const send = (response, status, body, headers = {}) => {
  response.writeHead(status, { "cache-control": "no-store", ...headers })
  response.end(body)
}

export const sendAdmin = (response, status, body, headers = {}) =>
  send(response, status, body, { ...SECURITY_HEADERS, ...headers })

export const sendAdminJson = (response, status, value, headers = {}) =>
  sendAdmin(response, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8", ...headers })

/**
 * 一条路径是否需要管理端鉴权（**默认拦截**；只放行明确无秘密的少数路径）。
 */
export function needsAdminAuth(path) {
  if (path === "/healthz") return false
  if (path === "/v1" || path.startsWith("/v1/")) return false
  if (path === CARRIER_PATH) return false
  if (path === LOGIN_PATH) return false
  if (path === LOGOUT_PATH) return false
  return true
}

/**
 * 未授权响应：浏览器（Accept 含 text/html）→ 302 登录页；脚本 → 401 JSON。
 */
export function respondUnauthorized(request, response, url) {
  const accept = String(request.headers?.accept ?? "")
  if (accept.includes("text/html")) {
    const next = encodeURIComponent(`${url.pathname}${url.search}`)
    sendAdmin(response, 302, "", { location: `${LOGIN_PATH}?next=${next}` })
    return
  }
  sendAdminJson(
    response,
    401,
    {
      error: "unauthorized",
      message: "管理端需要鉴权：浏览器请打开 /admin 用管理密钥登录；脚本请带 Authorization: Bearer <admin-key>。",
    },
    { "www-authenticate": 'Bearer realm="codearts2api admin"' },
  )
}
