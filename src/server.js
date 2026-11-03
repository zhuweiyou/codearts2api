/**
 * 对外 HTTP 服务：`/admin` 管理界面 + Jet Hub RPC 透传 + 健康检查
 * （+ `/v1/*` 网关反代）。
 *
 * ## 两个监听端口
 *
 * - 本服务（`PORT`，默认 8080）：管理界面、`POST /api/jet-hub`；
 * - 插件网关（`DSH_OPENAI_GATEWAY_PORT`，默认 8326）：OpenAI 兼容接口。
 *
 * 网关的监听地址由上游**硬编码**为 `127.0.0.1`（`DEFAULT_GATEWAY_HOST`
 * 不可经环境变量修改 —— 那是上游刻意的安全边界）。于是容器部署时外部
 * 根本连不到 8326，这正是下面反代存在的原因。
 *
 * ## `/v1/*` 反代**默认开启**（2026-10-20 起）
 *
 * 初版要 `PROXY_GATEWAY=1` 显式开启，理由是「本机开发直连 8326 更直观」。
 * 实测这个默认值是个**部署陷阱**：容器里忘了设就表现为「服务起来了，但
 * `/v1/*` 全部 404」，而 404 完全不像配置问题，用户会先去怀疑客户端参数。
 * 现在改为默认开启、显式关闭（`PROXY_GATEWAY=0`）。直连 8326 依然可用
 * （网关自己照旧监听），所以本机开发并没有失去什么。
 *
 * ⚠️ 透明转发 = **不碰 Authorization**：客户端仍须带插件网关的 Bearer Key，
 * 反代不注入、不校验、不换钥。这样「谁能用」「用哪个 Key」的判定始终只有
 * 插件网关一处，不会出现两套鉴权。
 *
 * ⚠️ SSE 必须**流式**转发（`Readable.fromWeb(...).pipe(...)`）。若图省事把
 * 上游响应 `await arrayBuffer()` 再回写，流式输出会变成「攒完一次性吐」，
 * 客户端表现为长时间无响应后突然全文出现 —— 那正是 OpenAI 客户端最容易
 * 超时报错的形态。
 *
 * ## 管理端鉴权（2026-10-20 新增）
 *
 * `/admin`、静态子资源与 `/api/jet-hub` 全部要求一个**独立于网关 Key** 的
 * 管理密钥（`<home>/admin-key` 或 `CODEARTS2API_ADMIN_KEY`）。理由与实现见
 * `admin-auth.js` 的模块头 —— 核心是：网关 Key 要发给调用方，管理权限不能跟着走。
 *
 * 浏览器侧走**登录页 → HttpOnly 会话 Cookie**，而不是「页面公开 + 弹密钥框」：
 * 后者必须先公开 `/admin` 与 `/admin.js`，等于白送「这台机器跑着 codearts2api」
 * 这个事实和一份 644KB 的上游管理 UI。前者连文档导航都拦住。
 *
 * 同时**仍然接受** `Authorization: Bearer <admin-key>` —— 否则 curl / 脚本 /
 * 监控就没法用了，而 README 里本来就有用 curl 调 RPC 的教程。
 *
 * 放行清单只有三条，且都是**刻意的**：
 *
 * | 路径 | 为什么放行 |
 * | --- | --- |
 * | `/healthz` | 不含密钥（只有开关、地址、模型数），要给监控 / 探活用 |
 * | `/v1/*` | 它有自己的 Bearer 校验（插件网关），判定权只在一处 |
 * | `/api/jet-hub/captcha-carrier` | 验证码载体页：页面里没有秘密（只有阿里云 SDK 的公开参数，见上游 `zcode-carrier-page.ts` 的注释），且它要被 `<webview>` 直接导航 —— 加鉴权会废掉 zcode 渠道 |
 *
 * 其余**一律拦截**（默认拒绝）。这里刻意不用「逐个列举要保护的路由」的
 * 黑名单：将来随手加一个 `/backup.json` 之类的静态文件时，黑名单会自动
 * 把它变成公开资源，而这类遗漏极难发现。
 *
 * ## 安全响应头
 *
 * 管理相关的响应统一带 CSP / `nosniff` / `X-Frame-Options` 等。注意 CSP 是
 * 按**页面能力**定的，不是越严越好：
 *
 * - `script-src 'self'`：页面只有三个同源脚本（`admin-boot.js` /
 *   `upstream-jet-hub.js` / `admin.js`），且已核实上游 bundle 里**没有**
 *   `eval` / `new Function` / 内联事件属性 —— 所以不需要 `'unsafe-eval'`。
 * - `style-src 'self' 'unsafe-inline'`：上游 UI 用 React 的 `style={{…}}`，
 *   那是**元素 style 属性**，CSS 的 `'unsafe-inline'` 覆盖不了它（它归
 *   `style-src-attr`），故这里必须放行 `'unsafe-inline'`。样式不执行代码，
 *   放宽它是可控的取舍。
 * - `img-src 'self' data: blob:`：`blob:` 是上游导出 CSV/JSON 时用
 *   `URL.createObjectURL` 造下载链接触发的（实测 bundle 里有 2 处）。
 * - `connect-src 'self'`：页面只跟自己的 `/api/jet-hub` 通信。
 */

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"

import { CARRIER_PATH, JET_HUB_PATH, rpcEnvelope } from "./upstream.js"
import {
  LOGIN_PATH,
  LOGOUT_PATH,
  LoginThrottle,
  clientIp,
  clearSessionCookie,
  constantTimeEquals,
  isAdminAuthorized,
  isSecureRequest,
  loadOrCreateAdminKey,
  sessionCookie,
} from "./admin-auth.js"
import { renderLoginPage, sanitizeNext } from "./admin-login-page.js"
// >>> caller-admin-import
import { createCallerAdmin } from "./caller-admin.js"
import { createDashboardAdmin } from "./dashboard-admin.js"
import { createModelsAdmin } from "./models-admin.js"
import { createCallersUiHandler } from "./callers-ui.js"
// <<< caller-admin-import
// >>> oauth-relay-import
import { createOAuthRelay } from "./oauth-relay.js"
// <<< oauth-relay-import

/** 请求体上限，与插件网关同值（16MB）。 */
const BODY_LIMIT = 16 * 1024 * 1024

/** 登录表单的上限（密钥就 43 字节，给足 4KB 已是慷慨）。 */
const LOGIN_BODY_LIMIT = 4 * 1024

/** 网关目标地址的缓存时长：网关可被开关启停，端口可能变，故不能永久缓存。 */
const TARGET_TTL_MS = 5_000

const here = fileURLToPath(new URL(".", import.meta.url))
/** 静态资源目录（`admin.html` 与构建出的 `admin.js`）。 */
const PUBLIC_DIR = join(here, "..", "public")

/**
 * 管理相关的安全响应头。
 *
 * `frame-ancestors 'none'` + `X-Frame-Options: DENY` 是**成对**的：后者给不支持
 * CSP 的老浏览器兜底。少了任一条，上游 UI 就可能在别的站点里被套框点击
 * （点击劫持），而管理界面里「删除账号」这类按钮的代价很高。
 */
const SECURITY_HEADERS = {
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

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

const send = (response, status, body, headers = {}) => {
  response.writeHead(status, { "cache-control": "no-store", ...headers })
  response.end(body)
}

/**
 * 发管理端响应：自动带上安全响应头。
 *
 * 登录页、管理页、错误页、JSON 全部走这里 —— 漏掉一处的后果是那一个响应缺少
 * 防点击劫持头，而这种缺口不会有人主动报障。
 */
const sendAdmin = (response, status, body, headers = {}) =>
  send(response, status, body, { ...SECURITY_HEADERS, ...headers })

const sendAdminJson = (response, status, value, headers = {}) =>
  sendAdmin(response, status, JSON.stringify(value), {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  })

/**
 * 静态文件白名单。
 *
 * 不拼用户输入，故无穿越面；仍收敛到固定几个名字，避免将来越加越多时
 * 引入目录穿越。
 *
 * ⚠️ 这张表里的**每一个**条目都受管理端鉴权保护（见文件头的「默认拒绝」）。
 */
const STATIC_FILES = new Map([
  ["/", "admin.html"],
  ["/admin", "admin.html"],
  ["/admin/", "admin.html"],
  ["/admin.css", "admin.css"],
  ["/admin-boot.js", "admin-boot.js"],
  ["/admin.js", "admin.js"],
  ["/upstream-jet-hub.js", "upstream-jet-hub.js"],
])

/** 逐跳头：不应转发（由本跳的连接自己决定）。 */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/**
 * 判断一条路径是否需要管理端鉴权。
 *
 * ## 为什么写成「默认拦截」
 *
 * 见文件头的同名段落：黑名单的失效方式是**静默**的（新资源自动公开），
 * 白名单的失效方式是**显式**的（新资源默认打不开，立刻有人报障）。
 * 后者是更安全的失败方向。
 *
 * @param path - `url.pathname`。
 * @returns 需要鉴权则为 `true`。
 */
export function needsAdminAuth(path) {
  // 探活：不含任何秘密，要给监控 / 容器 HEALTHCHECK 用。
  if (path === "/healthz") return false
  // OpenAI 兼容接口：它有自己的 Bearer 校验，鉴权判定权只在插件网关一处。
  if (path === "/v1" || path.startsWith("/v1/")) return false
  // 验证码载体页：页面里只有阿里云 SDK 的公开初始化参数，且要被 <webview>
  // 直接导航（那种导航带不了任何头）。加鉴权 = zcode 渠道直接不可用。
  // ⚠️ 必须**精确匹配**：它和 RPC 同一个 `/api/jet-hub` 前缀，用前缀判断会
  //    把整个管理 RPC 一起放行。
  if (path === CARRIER_PATH) return false
  // 登录页本身：不放行就永远登不进去（先有鸡还是先有蛋）。
  if (path === LOGIN_PATH) return false
  // 登出：只清 Cookie，无副作用可被利用。
  if (path === LOGOUT_PATH) return false
  return true
}

/** 把 WHATWG Request 所需的请求体读成 Buffer（带上限）。 */
function readBody(request, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("request body too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("error", reject)
    request.on("end", () => resolve(Buffer.concat(chunks)))
  })
}

/**
 * 把 node 的 req/res 适配成 WHATWG Request。
 *
 * 插件的 handler 是按 Web 标准写的（`request.json()`、`Response.json()`），
 * 而 `node:http` 给的是流式 req/res —— 这里转换一次，让插件代码**原样**
 * 运行，不需要为宿主做任何适配（也就不存在「两边行为漂移」）。
 */
async function toWebRequest(request, url) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  const method = request.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request)
  return new Request(url, { method, headers, body, ...(body === undefined ? {} : { duplex: "half" }) })
}

/** 把 WHATWG Response 写回 node res。 */
async function sendWebResponse(response, web) {
  const headers = {}
  web.headers.forEach((value, key) => {
    headers[key] = value
  })
  response.writeHead(web.status, headers)
  response.end(Buffer.from(await web.arrayBuffer()))
}

/**
 * 解析登录表单（`application/x-www-form-urlencoded`）。
 *
 * 不用 `URLSearchParams` 读整段是为了**先判长度**：`readBody` 已经带上限，
 * 但这里再显式一次，避免将来有人把 `readBody` 的上限改大时静默失去保护。
 *
 * @returns `{ key, next }`；格式非法时两者为空串。
 */
async function readLoginForm(request) {
  const raw = await readBody(request, LOGIN_BODY_LIMIT)
  const params = new URLSearchParams(raw.toString("utf8"))
  return {
    key: params.get("key") ?? "",
    next: params.get("next") ?? "",
  }
}

/**
 * 创建 HTTP 服务。
 *
 * ⚠️ **异步工厂**：装配阶段要读/生成管理密钥文件（`await loadOrCreateAdminKey`）。
 * 磁盘 I/O 一律异步，避免在服务启动路径上留同步读写。
 *
 * @param host - 插件宿主（`createHost()` 的返回值）。
 * @param options - `{ logger, proxyGateway, adminAuth, adminKey }`。
 *   `adminAuth: false` 关闭鉴权（仅本机开发；公网等于裸奔）。
 *   `adminKey` 用于测试注入，省略则从 home 解析。
 */
export async function createHttpServer(host, options = {}) {
  const proxyGateway = options.proxyGateway === true
  // >>> caller-gate
  const callerGate = options.callerGate ?? null
  // <<< caller-gate
  const logger = options.logger
  // >>> caller-admin
  // 管理面（分组 / key / 白名单）。
  // 只做 CRUD 与页面渲染，不参与 /v1 热路径。鉴权由下面的管理端鉴权门负责。
  const callerAdmin = createCallerAdmin({ home: host.home, logger })
  // <<< caller-admin
  // >>> oauth-relay
  // OAuth 回调中继：把上游硬绑 127.0.0.1:<端口> 的登录页/回调搬到 /relay/<port>/*。
  // 只在本机回环上取数，且整段挂在管理端鉴权门之后（未登录一律 401/302）。
  const oauthRelay = createOAuthRelay({ logger })
  // <<< oauth-relay
  const adminAuthEnabled = options.adminAuth !== false

  /** 管理密钥（读到就不变；`null` 表示鉴权已关闭）。 */
  let adminKey = typeof options.adminKey === "string" && options.adminKey !== "" ? options.adminKey : null
  if (adminAuthEnabled && adminKey === null) {
    const loaded = await loadOrCreateAdminKey(host.home)
    adminKey = loaded.value
    if (loaded.generated) {
      // ⚠️ 只在**首次生成**时打印全文：之后每次启动都打一遍，等于把它写进
      //    所有容器的日志历史里（docker logs 是长期可查的）。
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

  // >>> dashboard-admin
  // 总览看板：不占独立 URL，只提供 /admin/dashboard/api 与 /admin/dashboard-ui.js。
  // ⚠️ 必须建在 adminKey 解析之后 —— 看板靠 adminKey 打内部 RPC。
  // ⚠️ dataDir 就是 host.home，本身已经是 .../data。
  const dashboardAdmin = createDashboardAdmin({
    dataDir: host.home,
    rpc: async (method, payload) => {
      // 与 readGatewayState 同一条通道：直接打在插件路由上，不走网络。
      const route = host.routes.get(JET_HUB_PATH)
      if (route === undefined) throw new Error("jet-hub 路由未注册")
      const web = await route.fetch(
        new Request(`http://127.0.0.1${JET_HUB_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rpcEnvelope(method, payload ?? {}, "dashboard")),
        }),
      )
      const parsed = await web.json()
      if (parsed?.result?.error !== undefined) throw new Error(String(parsed.result.error))
      if (parsed?.result?.value === undefined) throw new Error(parsed?.result?.message ?? "空响应")
      return parsed.result.value
    },
    gateway: async () => {
      const state = await readGatewayState(host)
      return { ok: state?.running === true && state?.enabled !== false, gateway: state, providers: providerIds(host) }
    },
    logger,
  })
  // <<< dashboard-admin
  // >>> models-admin
  // 厂商模型清单与逐条开关：只代理上游 RPC，不自己实现开关语义。
  // ⚠️ 与其他管理模块一样建在 adminKey 解析之后，靠 adminKey 打内部 RPC。
  const modelsAdmin = createModelsAdmin({
    rpc: async (method, payload) => {
      const route = host.routes.get(JET_HUB_PATH)
      if (route === undefined) throw new Error("jet-hub 路由未注册")
      const web = await route.fetch(
        new Request(`http://127.0.0.1${JET_HUB_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rpcEnvelope(method, payload ?? {}, "models")),
        }),
      )
      const parsed = await web.json()
      if (parsed?.result?.error !== undefined) throw new Error(String(parsed.result.error))
      if (parsed?.result?.value === undefined) throw new Error(parsed?.result?.message ?? "空响应")
      return parsed.result.value
    },
    logger,
  })
  // <<< models-admin
  const callersUiHandler = createCallersUiHandler()

  /** 登录失败限速（按来源 IP）。 */
  const throttle = new LoginThrottle()

  /** 网关目标地址的缓存（避免每个请求都多一次本地 RPC）。 */
  let targetCache = { at: 0, host: undefined, port: undefined }

  /**
   * 解析网关当前监听地址。
   *
   * 走**插件公开的 RPC**（而不是读 env 猜端口）：端口被 `gateway.setEnabled`
   * 启停、或 env 改过时，只有插件自己知道真实地址。带 TTL 缓存，失败回退
   * 到 env 默认值，保证「探测偶发失败」不会让反代整体不可用。
   */
  async function resolveGatewayTarget() {
    if (Date.now() - targetCache.at < TARGET_TTL_MS) return targetCache
    let resolved
    const state = await readGatewayState(host).catch(() => null)
    if (state?.address?.port !== undefined) resolved = { host: state.address.host, port: state.address.port }
    else {
      // 网关未运行/读不到：退回 env 默认（请求会失败并给出可读错误）。
      const raw = process.env.DSH_OPENAI_GATEWAY_PORT
      const port = raw === undefined || raw.trim() === "" ? 8326 : Number.parseInt(raw, 10)
      resolved = { host: "127.0.0.1", port: Number.isInteger(port) ? port : 8326 }
    }
    targetCache = { at: Date.now(), ...resolved }
    return targetCache
  }

  /**
   * 透明转发 `/v1/*` 到插件网关。
   *
   * 请求体直接用 node 的 req 流式透传（不缓冲）；响应体流式回写以保住 SSE。
   */
  async function proxyToGateway(request, response, url) {
    const target = await resolveGatewayTarget()
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
      if (Array.isArray(value)) for (const item of value) headers.append(key, item)
      else headers.set(key, value)
    }

    const method = request.method ?? "GET"
    const hasBody = method !== "GET" && method !== "HEAD"

    // >>> caller-gate
    let gateEntry = null
    let gateModel
    let gateBody
    if (callerGate) {
      const verdict = await callerGate.inspect(request, url, method)
      if (!verdict.ok) {
        callerGate.sendJson(response, verdict.status ?? 403, { error: verdict.error })
        return
      }
      if (!verdict.disabled) {
        gateEntry = verdict.entry ?? null
        gateModel = verdict.model
        gateBody = verdict.body
        // 上游真 key 可能是从文件现读的（异步），故这里 await。
        const upstreamKey = await callerGate.upstreamKey()
        if (upstreamKey) headers.set("authorization", `Bearer ${upstreamKey}`)
        if (gateEntry?.id) headers.set("x-caller-id", String(gateEntry.id))
      }
    }
    // <<< caller-gate

    let upstream
    try {
      upstream = await fetch(`http://${target.host}:${target.port}${url.pathname}${url.search}`, {
        method,
        headers,
        // 直接传 req（Readable）：undici 会流式发送，不把 16MB 上限内的请求体
        // 整个读进内存。`duplex: 'half'` 是带流 body 时的必需项。
        body: gateBody ?? (hasBody ? request : undefined),
        ...(hasBody ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(options.upstreamTimeoutMs ?? 600_000),
      })
    } catch (error) {
      // 网关没起来（被关掉 / 端口冲突 / 启动失败）：回 OpenAI 形态的错误，
      // 让客户端能读懂，而不是一个空连接或 HTML 500。
      logger?.warn?.(`[proxy] 网关不可达（${target.host}:${target.port}）：${String(error)}`)
      sendAdminJson(response, 502, {
        error: {
          message: `本机网关不可达（${target.host}:${target.port}）。请在 /admin 里确认网关已开启。`,
          type: "server_error",
          code: "gateway_unreachable",
        },
      })
      return
    }

    // >>> caller-gate
    if (callerGate && gateEntry && url.pathname === "/v1/models" && upstream.ok) {
      try {
        const payload = await upstream.json()
        callerGate.sendJson(response, 200, callerGate.filterModels(payload, gateEntry))
        return
      } catch {
        /* 解析失败就退回原始流 */
      }
    }
    // <<< caller-gate

    const outHeaders = {}
    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP.has(key.toLowerCase())) return
      outHeaders[key] = value
    })
    response.writeHead(upstream.status, outHeaders)

    if (upstream.body === null) {
      response.end()
      return
    }
    // 流式回写：SSE 的每一帧立即到达客户端，而不是等整段生成完。
    // 客户端中途断开时销毁上游流，避免上游继续生成白耗额度。
    const stream = Readable.fromWeb(upstream.body)
    response.once("close", () => {
      if (!response.writableEnded) stream.destroy()
    })
    stream.on("error", () => response.destroy())
    // >>> caller-gate
    const outStream = callerGate
      ? callerGate.tapStream(stream, {
          status: upstream.status,
          callerId: gateEntry?.id,
          callerName: gateEntry?.name,
          callerGroup: gateEntry?.group,
          model: gateModel,
          path: url.pathname,
          stream: String(upstream.headers.get("content-type") ?? "").includes("event-stream"),
        })
      : stream
    outStream.pipe(response)
    // <<< caller-gate
  }

  /**
   * 未授权时的响应：**看调用方要什么**再决定形态。
   *
   * - 浏览器（`Accept` 含 `text/html`）：302 到登录页，并带上 `next` 以便登录后回来。
   *   若在这里直接回 401 JSON，用户看到的是满屏花括号，会以为是服务坏了。
   * - 脚本 / 客户端：401 + JSON，并在 `WWW-Authenticate` 里点明方案（便于 curl 调试）。
   */
  function respondUnauthorized(request, response, url) {
    const accept = String(request.headers?.accept ?? "")
    const wantsHtml = accept.includes("text/html")
    if (wantsHtml) {
      const next = encodeURIComponent(`${url.pathname}${url.search}`)
      sendAdmin(response, 302, "", { location: `${LOGIN_PATH}?next=${next}` })
      return
    }
    sendAdminJson(
      response,
      401,
      {
        error: "unauthorized",
        // 与登录页同理：这是**未认证**响应，不能回显密钥文件路径或来源（环境变量 vs 文件），
        // 否则等于替攻击者标好下一步。这里只说明「怎么鉴权」，不透露密钥存在哪里。
        message: "管理端需要鉴权：浏览器请打开 /admin 用管理密钥登录；脚本请带 Authorization: Bearer <admin-key>。",
      },
      // 点明认证方案：curl 这类客户端会据此提示，也便于确认「服务认得 Bearer」。
      { "www-authenticate": 'Bearer realm="codearts2api admin"' },
    )
  }

  /** 渲染登录页（可带错误提示）。 */
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

  /** 鉴权是否真的在生效（关闭时一律放行）。 */
  function adminKeyEnabled() {
    return adminAuthEnabled && typeof adminKey === "string" && adminKey !== ""
  }

  /** 处理登录表单提交。 */
  async function handleLogin(request, response, url) {
    if (request.method === "GET" || request.method === "HEAD") {
      // 已登录的人访问登录页：直接送回后台，而不是让他再输一遍。
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
      // 会话 Cookie 的 `Secure` 只在真的走 HTTPS 时加。理由见 admin-auth.js 的
      // `sessionCookie`：默认加会让「http://ip:8080 直连」的用户永远登不进去。
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

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`)
    const path = url.pathname

    try {
      // ── 健康检查（无鉴权，刻意不含密钥）──
      if (path === "/healthz") {
        const gateway = await readGatewayState(host)
        sendAdminJson(response, 200, {
          ok: true,
          home: host.home,
          routes: [...host.routes.keys()],
          providers: providerIds(host),
          proxyGateway,
          adminAuth: adminKeyEnabled(),
          gateway,
        })
        return
      }

      // ── 登录 / 登出（无鉴权，否则永远进不去）──
      if (path === LOGIN_PATH) {
        await handleLogin(request, response, url)
        return
      }
      if (path === LOGOUT_PATH) {
        response.writeHead(303, {
          ...SECURITY_HEADERS,
          "cache-control": "no-store",
          "set-cookie": clearSessionCookie(),
          location: LOGIN_PATH,
        })
        response.end()
        return
      }

      // ── OpenAI 兼容反代（默认开启；有自己的 Bearer 鉴权）──
      const isV1 = path === "/v1" || path.startsWith("/v1/")
      if (proxyGateway && isV1) {
        await proxyToGateway(request, response, url)
        return
      }
      // 反代被显式关掉（`PROXY_GATEWAY=0`）时给一句能读懂的话，而不是裸 404：
      // 端口开着、服务在跑、却只回 `{"error":"not found"}`，用户会去怀疑
      // base_url / api_key / 客户端配置，而不是「有个环境变量把这条路关了」。
      if (isV1) {
        sendAdminJson(response, 404, {
          error: {
            message:
              "/v1/* 在本端口不可用：已通过 PROXY_GATEWAY=0 关闭反代。" +
              "请改为直连插件网关（默认 127.0.0.1:8326，地址见 /healthz），或去掉 PROXY_GATEWAY=0 后重启。",
            type: "invalid_request_error",
            code: "proxy_disabled",
          },
        })
        return
      }

      // ── 验证码载体页（放行：页面无秘密，且要被 <webview> 直接导航）──
      if (path === CARRIER_PATH) {
        const outcome = await host.handleRpc(CARRIER_PATH, await toWebRequest(request, url.href))
        if (outcome === undefined) {
          send(response, 404, "载体页未注册")
          return
        }
        await sendWebResponse(response, outcome)
        return
      }

      // ── 管理端鉴权门（其余一切都在门后）──
      //
      // `adminKeyEnabled()` 为假（`CODEARTS2API_ADMIN_AUTH=0`）时整道门拆掉 ——
      // 这也是本机开发想要的行为。⚠️ 注意不能只写 `!isAdminAuthorized(...)`：
      // 密钥为空时它恒返回 false，会把所有请求都拦下，表现为「关了鉴权反而全 401」。
      if (adminKeyEnabled() && needsAdminAuth(path) && !isAdminAuthorized(request, adminKey)) {
        respondUnauthorized(request, response, url)
        return
      }

      // >>> caller-admin-dispatch
      // 调用方管理页（/admin/callers）。放在鉴权门之后 = 未登录会被 302 到登录页。
      if (await callerAdmin.handle(request, response, url)) return
      // >>> dashboard-admin
      if (await dashboardAdmin.handle(request, response, url)) return
      // >>> models-admin
      if (await modelsAdmin.handle(request, response, url)) return
      // <<< models-admin
      // <<< dashboard-admin
      // >>> callers-ui
      // 调用方管理的弹窗 UI 脚本（数据仍走 /admin/callers/api，不重复实现后端）。
      if (callersUiHandler(request, response, url)) return
      // <<< callers-ui
      // <<< caller-admin

      // >>> oauth-relay-dispatch
      // OAuth 回调中继（/relay/<port>/* 与 /admin/oauth-relay/replay）。
      // 同样在鉴权门之后：/relay/* 必须登录，否则等于把本机 OAuth 监听器暴露到公网。
      if (await oauthRelay.handle(request, response, url)) return
      // <<< oauth-relay-dispatch

      // ── Jet Hub 管理 RPC（透传给插件）──
      if (path === JET_HUB_PATH) {
        const outcome = await host.handleRpc(JET_HUB_PATH, await toWebRequest(request, url.href))
        if (outcome === undefined) {
          sendAdminJson(response, 404, { error: "Jet Hub 端点未注册" })
          return
        }
        await sendWebResponse(response, outcome)
        return
      }

      // ── 静态资源 ──
      const file = STATIC_FILES.get(path)
      if (file !== undefined && (request.method === "GET" || request.method === "HEAD")) {
        const target = join(PUBLIC_DIR, file)
        // 一次 readFile 就够了：`existsSync` + `readFileSync` 那种两步写法既有
        // TOCTOU 窗口，也在每个页面/脚本请求上堵住事件循环（admin.js 有 600KB+）。
        let body
        try {
          body = await readFile(target)
        } catch (error) {
          if (error?.code !== "ENOENT") throw error
          sendAdmin(response, 503, "管理界面尚未构建：请先执行 npm run build", {
            "content-type": "text/plain; charset=utf-8",
          })
          return
        }
        sendAdmin(response, 200, body, {
          "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
        })
        return
      }

      sendAdminJson(response, 404, { error: "not found" })
    } catch (error) {
      // 兜底：任何未捕获异常都必须变成响应，否则连接会挂住、前端表现为「点了没反应」。
      logger?.error?.(`[http] ${request.method} ${path} 处理失败：${String(error)}`)
      if (!response.headersSent) sendAdminJson(response, 500, { error: String(error) })
      else response.end()
    }
  })

  return server
}

/**
 * 读网关状态。
 *
 * 同时服务于 `/healthz` 与反代的目标解析，故直接返回**插件原始响应**；
 * 调用方各自裁剪。失败返回 `null`（不影响服务本身）。
 */
async function readGatewayState(host) {
  try {
    const route = host.routes.get(JET_HUB_PATH)
    if (route === undefined) return null
    const web = await route.fetch(
      new Request(`http://127.0.0.1${JET_HUB_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcEnvelope("gateway.getEnabled", {}, "healthz")),
      }),
    )
    const parsed = await web.json()
    const value = parsed?.result?.value
    if (value === undefined) return null
    return {
      enabled: value.enabled,
      running: value.running,
      blockedByEnv: value.blockedByEnv,
      address: value.address,
      modelsSource: value.modelsSource,
      modelCount: Array.isArray(value.models) ? value.models.length : 0,
      // ⚠️ 刻意**不**把 apiKey 明文放进健康检查：它可能被日志、监控或 CDN 记录。
      // 需要 Key 的用户在 /admin 里点「复制」（或走 gateway.getEnabled，那是
      // 显式的用户操作）—— 参见上游对「明文只用于设置页展示」的取舍。
    }
  } catch {
    return null
  }
}

/** 已注册的 llm provider id（读不到就回空数组）。 */
function providerIds(host) {
  try {
    const llm = host.ctx.get("llm")
    const listed = llm?.listProviders?.()
    return Array.isArray(listed) ? listed.map((entry) => entry.id) : []
  } catch {
    return []
  }
}
