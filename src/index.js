/**
 * 进程入口：装配宿主 → 起 HTTP → 优雅退出。
 *
 * ## 启动是两个独立的监听
 *
 * - 本站点（`PORT`）：管理界面 `/admin` 与 Jet Hub RPC；
 * - 插件网关（`DSH_OPENAI_GATEWAY_PORT`）：OpenAI 兼容接口。
 *
 * 网关由插件在 `apply()` 里**自行**根据开关启动，本站点**不**干预它 ——
 * 启停只经 `gateway.setEnabled` 这条 RPC。因此这里只确保本站点起来了，
 * 网关的状态由 `/healthz` 与 `/admin` 反映。
 *
 * ## 退出必须走 close()
 *
 * 插件的 `apply()` 用 `ctx.effect` 注册了若干清理器（续期定时器、
 * zcode 的 captcha 子进程、opencode 的代理连接池、网关的 HTTP server）。
 * 直接 `process.exit()` 会留下孤儿 chromium（数百 MB）与挂住的 socket，
 * 故 SIGINT/SIGTERM 都必须走 `host.close()`。
 */

import { createHost } from "./host.js"
import { createHttpServer } from "./server.js"
import { join as joinPath } from "node:path"
import { readFile } from "node:fs/promises"
import { createCallerGate } from "./caller-gate.js"

/** 默认管理端口。 */
const DEFAULT_PORT = 8080

/**
 * 解析端口。非法值**显式失败**，不静默换端口
 * （与插件网关对 `DSH_OPENAI_GATEWAY_PORT` 的取舍一致：静默改端口会让
 * 用户按文档配的反代指向空）。
 */
function resolvePort(env = process.env) {
  const raw = env.PORT
  if (raw === undefined || raw === "") return DEFAULT_PORT
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw.trim()) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，收到：${raw}`)
  }
  return port
}

/** 监听地址：默认全网卡（容器里必须如此，否则宿主访问不到）。 */
function resolveHost(env = process.env) {
  const raw = env.HOST?.trim()
  return raw === undefined || raw === "" ? "0.0.0.0" : raw
}

/**
 * 是否把 `/v1/*` 反代到插件网关。
 *
 * **默认开启**（2026-10-20 起）。初版是默认关闭、要 `PROXY_GATEWAY=1` 显式打开，
 * 理由是「本机开发直连 8326 更直观」。实测这个默认值是个部署陷阱：容器里忘了设
 * 就表现为「服务起来了但 `/v1/*` 全部 404」，而 404 完全不像配置问题，用户会先去
 * 怀疑客户端的 base_url / api_key。
 *
 * 改成默认开启不损失什么 —— 网关自己照旧监听 8326，本机开发仍可直连。
 * 需要关掉时显式设 `PROXY_GATEWAY=0`。
 */
function resolveProxyGateway(env = process.env) {
  const raw = env.PROXY_GATEWAY?.trim().toLowerCase()
  // 未设置（undefined）或空串 ⇒ 开启；只有明确的否定词才关闭。
  if (raw === undefined || raw === "") return true
  return !["0", "false", "off", "no"].includes(raw)
}

/**
 * 是否启用管理端鉴权。
 *
 * **默认开启**，且只提供「关闭」这一个例外 —— 安全性应该是默认值，
 * 「方便」才该是被显式声明的那个。
 *
 * `CODEARTS2API_ADMIN_AUTH=0` 只用于本机开发调试：它会让 `/admin` 与
 * `/api/jet-hub` 对任何能访问该端口的人开放（启动日志会显著告警）。
 */
function resolveAdminAuth(env = process.env) {
  const raw = env.CODEARTS2API_ADMIN_AUTH?.trim().toLowerCase()
  if (raw === undefined || raw === "") return true
  return !["0", "false", "off", "no"].includes(raw)
}

const host = await createHost()
const port = resolvePort()
const bind = resolveHost()
const proxyGateway = resolveProxyGateway()

// >>> caller-gate
// data/caller-keys.json 不存在时闸门自动关闭，行为与改造前一致。

/**
 * 上游网关 Key 的短缓存。
 *
 * 为什么不能只在启动时读一次：用户可以在 `/admin` 里重置网关 Key（那会重写
 * `openai-gateway/api-key`），读死值就会让「换过 Key 之后所有 /v1 请求 401」。
 *
 * 为什么不能每个请求都异步读一遍：每次读盘都是真实 I/O（`/v1` 是热路径）。
 * 折中：命中缓存 5 秒；**读不到不缓存**（文件可能刚被创建，下一次立刻重试）。
 */
const upstreamKeyCache = { value: null, until: 0 }

async function readUpstreamKey() {
  const fromEnv = process.env.DSH_OPENAI_GATEWAY_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  if (upstreamKeyCache.value !== null && Date.now() < upstreamKeyCache.until) return upstreamKeyCache.value
  try {
    const value = (await readFile(joinPath(host.home, "openai-gateway", "api-key"), "utf8")).trim()
    if (!value) return null
    upstreamKeyCache.value = value
    upstreamKeyCache.until = Date.now() + 5_000
    return value
  } catch {
    upstreamKeyCache.value = null
    upstreamKeyCache.until = 0
    return null
  }
}

const callerGate = createCallerGate({
  home: host.home,
  logger: console,
  upstreamKey: readUpstreamKey,
})
// <<< caller-gate
const adminAuth = resolveAdminAuth()

const server = await createHttpServer(host, { logger: console, proxyGateway, adminAuth, callerGate })
await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.once("listening", resolve)
  server.listen(port, bind)
})

const shown = bind === "0.0.0.0" ? "127.0.0.1" : bind
console.log(`[codearts2api] 管理界面 http://${shown}:${port}/admin`)
console.log(`[codearts2api] state home: ${host.home}`)
console.log(`[codearts2api] 已注册路由: ${[...host.routes.keys()].join(", ") || "（无）"}`)
if (proxyGateway) console.log(`[codearts2api] /v1/* 已反代到本机插件网关（PROXY_GATEWAY=0 可关闭）`)
else console.log(`[codearts2api] PROXY_GATEWAY=0：本端口不提供 /v1/*，请直连插件网关（默认 127.0.0.1:8326）`)
if (!adminAuth) {
  console.warn(
    "[codearts2api] ⚠️ CODEARTS2API_ADMIN_AUTH=0：管理端鉴权已关闭，/admin 与 /api/jet-hub 无任何保护。" +
      "只应在本机调试时这样用。",
  )
}

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[codearts2api] 收到 ${signal}，正在关闭…`)
  // 兜底强制退出：插件清理里可能有等待网络的部分（如 captcha 子进程回收），
  // 不能让它无限期吊住进程。仍在飞行的请求由 closeAllConnections 收掉。
  const force = setTimeout(() => {
    console.warn("[codearts2api] 关闭超时，强制退出")
    server.closeAllConnections?.()
    process.exit(0)
  }, 10_000)
  force.unref?.()

  await new Promise((resolve) => server.close(() => resolve()))
  try {
    await host.close()
  } catch (error) {
    console.error(`[codearts2api] 插件清理失败：${String(error)}`)
  }
  clearTimeout(force)
  process.exit(0)
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
