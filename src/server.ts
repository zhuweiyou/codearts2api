/**
 * 对外 HTTP 服务 —— 基于 **Express** 的路由编排层。
 * 具体职责在 `src/http/*`：security / body / admin-login / gateway / frontend。
 * 管理端 handler（dashboard/callers/models/oauth-relay）以 Express 中间件方式挂载；
 * `/v1/*` 仍以原始 handler 调用（streaming + caller-gate 记账保持不变）。
 */
import { createServer } from "node:http"

import express from "express"

import { LOGIN_PATH, LOGOUT_PATH, LoginThrottle, isAdminAuthorized } from "./admin-auth.ts"
import { API_PATH as CALLER_API_PATH, createCallerAdmin } from "./caller-admin.ts"
import { createDashboardAdmin } from "./dashboard-admin.ts"
import { createAdminLoginRoutes } from "./http/admin-login.ts"
import { readBody } from "./http/body.ts"
import { serveFrontend } from "./http/frontend.ts"
import { createGatewayProxy, providerIds, readGatewayState } from "./http/gateway.ts"
import { needsAdminAuth, respondUnauthorized, send, sendAdmin, sendAdminJson } from "./http/security.ts"
import { createModelsAdmin } from "./models-admin.ts"
import { createOAuthRelay } from "./oauth-relay.ts"
import { CARRIER_PATH, JET_HUB_PATH, rpcEnvelope } from "./upstream.ts"

// 兼容旧引用。
export { needsAdminAuth } from "./http/security.ts"

/** node req/res ↔ WHATWG Request/Response 适配。 */
async function toWebRequest(request, href) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value as string)
  }
  const method = request.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request)
  return new Request(href, { method, headers, body, ...(body === undefined ? {} : { duplex: "half" }) })
}

async function sendWebResponse(response, web) {
  const headers = {}
  web.headers.forEach((value, key) => {
    headers[key] = value
  })
  response.writeHead(web.status, headers)
  response.end(Buffer.from(await web.arrayBuffer()))
}

/**
 * 创建 HTTP 服务。
 * @param host { logger, home, routes, handleRpc, ctx }
 * @param options { logger, proxyGateway, adminAuth, adminKey, callerGate, upstreamTimeoutMs }
 */
export async function createHttpServer(host, options: any = {}) {
  const proxyGateway = options.proxyGateway === true
  const callerGate = options.callerGate ?? null
  const logger = options.logger
  const callerAdmin = createCallerAdmin({ home: host.home, logger })
  const oauthRelay = createOAuthRelay({ logger })
  const adminAuthEnabled = options.adminAuth !== false

  /** 管理密钥（读到就不变；null 表示鉴权已关闭）。 */
  let adminKey = typeof options.adminKey === "string" && options.adminKey !== "" ? options.adminKey : null
  if (adminAuthEnabled && adminKey === null) {
    const { loadOrCreateAdminKey } = await import("./admin-auth.ts")
    const loaded = await loadOrCreateAdminKey(host.home)
    adminKey = loaded.value
    if (loaded.generated) {
      logger?.info?.(`[admin-auth] 已生成管理密钥（仅本次打印，之后请查看文件）：${loaded.value}`)
      logger?.info?.(`[admin-auth] 密钥文件：${loaded.path}`)
    } else if (loaded.fromEnv) {
      logger?.info?.("[admin-auth] 管理密钥取自 CODEARTS2API_ADMIN_KEY 环境变量")
    } else {
      logger?.info?.(`[admin-auth] 管理密钥文件：${loaded.path}`)
    }
  } else if (!adminAuthEnabled) {
    logger?.warn?.(
      "[admin-auth] ⚠️ 管理端鉴权已被 CODEARTS2API_ADMIN_AUTH=0 关闭 —— /admin 与 /api/jet-hub 对任何能访问该端口的人开放。",
    )
  }
  const adminKeyEnabled = () => adminAuthEnabled && typeof adminKey === "string" && adminKey !== ""

  // 管理端 RPC（dashboard/models 共用）：直接打在插件路由上，不走网络。
  const adminRpc = async (method, payload, tag) => {
    const route = host.routes.get(JET_HUB_PATH)
    if (route === undefined) throw new Error("jet-hub 路由未注册")
    const web = await route.fetch(
      new Request(`http://127.0.0.1${JET_HUB_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcEnvelope(method, payload ?? {}, tag)),
      }),
    )
    const parsed = await web.json()
    if (parsed?.result?.error !== undefined) throw new Error(String(parsed.result.error))
    if (parsed?.result?.value === undefined) throw new Error(parsed?.result?.message ?? "空响应")
    return parsed.result.value
  }

  const dashboardAdmin = createDashboardAdmin({
    dataDir: host.home,
    rpc: (method, payload) => adminRpc(method, payload, "dashboard"),
    gateway: async () => {
      const state = await readGatewayState(host)
      return { ok: state?.running === true && state?.enabled !== false, gateway: state, providers: providerIds(host) }
    },
    logger,
  })
  const modelsAdmin = createModelsAdmin({ rpc: (method, payload) => adminRpc(method, payload, "models"), logger })

  const throttle = new LoginThrottle()
  const { proxyToGateway } = createGatewayProxy({
    host,
    callerGate,
    logger,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
  })
  const { handleLogin, handleLogout } = createAdminLoginRoutes({ adminKeyEnabled, adminKey, throttle, logger })

  const app = express()
  app.disable("x-powered-by")

  const urlOf = (req) => new URL(req.originalUrl ?? req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
  const a = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
  /** 把 (req,res,url)->boolean 的旧 handler 包成 Express 中间件。 */
  const mount = (handler) => async (req, res, next) => {
    try {
      if (await handler.handle(req, res, urlOf(req))) return
      next()
    } catch (err) {
      next(err)
    }
  }

  // 健康检查（无鉴权）
  app.get(
    "/healthz",
    a(async (req, res) => {
      const gateway = await readGatewayState(host)
      sendAdminJson(res, 200, {
        ok: true,
        home: host.home,
        routes: [...host.routes.keys()],
        providers: providerIds(host),
        proxyGateway,
        adminAuth: adminKeyEnabled(),
        gateway,
      })
    }),
  )

  // 登录 / 登出
  app.all(
    LOGIN_PATH,
    a((req, res) => handleLogin(req, res, urlOf(req))),
  )
  app.all(LOGOUT_PATH, (req, res) => handleLogout(req, res))

  // 首页与 /admin 等价 → /admin/
  app.get("/", (req, res) => sendAdmin(res, 302, "", { location: "/admin/" }))

  // /v1/* 反代（自带 Bearer 鉴权；保留 streaming + caller-gate）
  app.use("/v1", (req, res, next) => {
    if (!proxyGateway) {
      sendAdminJson(res, 404, {
        error: {
          message:
            "/v1/* 在本端口不可用：已通过 PROXY_GATEWAY=0 关闭反代。请改为直连插件网关（默认 127.0.0.1:8326，地址见 /healthz），或去掉 PROXY_GATEWAY=0 后重启。",
          type: "invalid_request_error",
          code: "proxy_disabled",
        },
      })
      return
    }
    proxyToGateway(req, res, urlOf(req)).catch(next)
  })

  // 验证码载体页（放行）
  app.all(
    CARRIER_PATH,
    a(async (req, res) => {
      const outcome = await host.handleRpc(CARRIER_PATH, await toWebRequest(req, urlOf(req).href))
      if (outcome === undefined) {
        send(res, 404, "载体页未注册")
        return
      }
      await sendWebResponse(res, outcome)
    }),
  )

  // 管理端鉴权门（其余一切）
  app.use((req, res, next) => {
    const url = urlOf(req)
    if (adminKeyEnabled() && needsAdminAuth(url.pathname) && !isAdminAuthorized(req, adminKey)) {
      respondUnauthorized(req, res, url)
      return
    }
    next()
  })

  // 调用方管理：只路由 API（/admin/callers/api）。页面由前端 SPA 提供，
  // 避免 caller-admin 里的旧独立页（PAGE_PATH=/admin/callers）抢先响应 SPA 路由。
  app.use(
    a(async (req, res, next) => {
      if (urlOf(req).pathname !== CALLER_API_PATH) return next()
      const handled = await callerAdmin.handle(req, res, urlOf(req))
      if (!handled) next()
    }),
  )
  app.use(mount(dashboardAdmin))
  app.use(mount(modelsAdmin))
  app.use(mount(oauthRelay))

  // Jet Hub 管理 RPC
  app.all(
    JET_HUB_PATH,
    a(async (req, res) => {
      const outcome = await host.handleRpc(JET_HUB_PATH, await toWebRequest(req, urlOf(req).href))
      if (outcome === undefined) {
        sendAdminJson(res, 404, { error: "Jet Hub 端点未注册" })
        return
      }
      await sendWebResponse(res, outcome)
    }),
  )

  // 前端 dist/（assets + SPA 回退）
  app.use(
    a(async (req, res, next) => {
      if (await serveFrontend(req, res, urlOf(req).pathname)) return
      next()
    }),
  )

  // 404
  app.use((req, res) => {
    if (!res.headersSent) sendAdminJson(res, 404, { error: "not found" })
  })

  // 统一错误处理
  app.use((err, req, res, _next) => {
    logger?.error?.(`[http] ${req.method} ${req.originalUrl} 处理失败：${String(err)}`)
    if (!res.headersSent) sendAdminJson(res, 500, { error: String(err) })
    else res.end()
  })

  return createServer(app)
}
