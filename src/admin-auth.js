/**
 * 管理端鉴权：一把**独立于网关 Key** 的管理密钥 + 会话 Cookie。
 *
 * ## 为什么不能复用网关的 `api-key`
 *
 * 网关 Key（`<home>/openai-gateway/api-key`）是**发给调用方**的 —— 你要把它填进
 * Cline / Cursor / 别人的客户端里。而管理端能 `backup.export`（导出全部账号凭据）
 * 与 `gateway.getEnabled`（明文取回 Key）。两者权限等级差了一个数量级，
 * 共用一把就等于「谁都能调 API，谁都能进后台改配置」。所以这里**另起一把**。
 *
 * ## 为什么需要 Cookie（而不是只用 Bearer）
 *
 * 浏览器里点开 `/admin` 是一次**文档导航**，导航请求**不可能**带 `Authorization`
 * 头（这是浏览器行为，不是我们的选择）；页面里的 `<script src="/admin.js">`
 * 同理。所以「页面本身也要拦住」只有两条路：
 *
 * 1. 页面公开、只拦 API（参考仓库 workbuddy2api-panel 的取舍）——
 *    代价是任何人都能确认「这台机器跑着 codearts2api」并看到后台长什么样；
 * 2. **登录表单换一个会话 Cookie**，之后的导航与子资源都自动带上。
 *
 * 这里选 **2**：既然要求是「进页面鉴权」，页面就得真的拦住。同时**仍然接受**
 * `Authorization: Bearer <admin-key>`，否则 curl / 脚本 / 监控就无法访问，
 * 而 README 里本来就有用 curl 调 RPC 的教程。
 *
 * ## 会话令牌为什么是「HMAC(key, 固定串)」而不是随机数 + 内存表
 *
 * 随机会话需要服务端存表：进程一重启全部失效（用户被踢出去），多实例还要共享
 * 存储。而 `HMAC(admin-key, 常量)` 有两个刚好需要的性质：
 *
 * - **不可伪造**：没有 admin-key 就算不出它（它是密钥的函数，不是哈希本身）；
 * - **不泄露密钥**：单向函数，拿到 Cookie 推不回 admin-key；
 * - **天然失效**：换了 admin-key，旧 Cookie 立刻作废 —— 这正是我们想要的语义。
 *
 * 代价是「无法单独吊销某一个会话」。对自用网关可以接受（换 key = 全体下线）。
 *
 * ## 密钥从哪来
 *
 * 1. `CODEARTS2API_ADMIN_KEY` 环境变量（容器 / CI 用）；
 * 2. `<home>/admin-key` 文件（首次启动自动生成，`0600`）。
 *
 * 与上游 `loadOrCreateApiKey` 同一条纪律：**文件内容异常时报错，不静默换新**。
 * 静默换钥的后果是所有已登录的浏览器同时掉线，而用户只会看到「又要重新输密码」，
 * 无从判断是自己输错了还是密钥被换了。
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** 密钥文件名（放在 state home 下）。 */
export const ADMIN_KEY_FILE = "admin-key"

/** 会话 Cookie 名。 */
export const SESSION_COOKIE = "c2a_admin"

/** 登录页路由（未鉴权可达，否则永远登不进去）。 */
export const LOGIN_PATH = "/admin/login"

/** 登出路由。 */
export const LOGOUT_PATH = "/admin/logout"

/**
 * 自动生成的密钥形态：`randomBytes(32).toString("base64url")` = 43 位。
 *
 * 定长是关键 —— 它让「文件里是我们写的东西」可以被机械判定，从而把「损坏」
 * 与「用户自己换过」区分开（见 {@link loadOrCreateAdminKey}）。
 */
const ADMIN_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** 会话令牌的 HMAC 输入（常量；改它 = 让所有已发出的 Cookie 失效）。 */
const SESSION_LABEL = "codearts2api-admin-session-v1"

/** 会话 Cookie 的有效期（秒）。自用网关取 30 天，避免天天重登。 */
const SESSION_MAX_AGE = 30 * 24 * 60 * 60

/**
 * 读取或生成管理密钥。
 *
 * ⚠️ **异步**：磁盘 I/O 一律走 `node:fs/promises`。本函数在启动时只跑一次，
 * 同步写也不会卡住谁，但本项目其余读写都已异步化 —— 留着同步调用等于给后来人
 * 立一个「这里可以 sync」的先例，而那正是把事件循环堵死的起点。
 *
 * @param home - state home 目录。
 * @param env - 进程环境变量（便于单测注入）。
 * @returns `Promise<{ value, path, fromEnv, generated }>`。
 */
export async function loadOrCreateAdminKey(home, env = process.env) {
  const configured = env.CODEARTS2API_ADMIN_KEY?.trim()
  if (configured) return { value: configured, path: null, fromEnv: true, generated: false }

  const path = join(home, ADMIN_KEY_FILE)
  let stored
  try {
    stored = (await readFile(path, "utf8")).trim()
  } catch {
    // 不存在 / 不可读：走生成路径；写入失败会向调用方暴露。
  }

  if (stored) {
    if (ADMIN_KEY_PATTERN.test(stored)) return { value: stored, path, fromEnv: false, generated: false }
    throw new Error(
      `管理密钥文件内容异常（不是本程序生成的形态）：${path}。` +
        "可能是被手工编辑或被其它程序改写；本程序不会静默更换它，否则所有已登录的浏览器会同时掉线。" +
        "如需更换：删除该文件后重启（会重新生成，届时需要重新登录），或改用 CODEARTS2API_ADMIN_KEY 环境变量。",
    )
  }

  const key = randomBytes(32).toString("base64url")
  await mkdir(home, { recursive: true })
  // 先写临时文件再 rename：避免「写到一半崩了」留下半个密钥（那会让下次启动
  // 读到不符合形态的内容并直接报错，用户只能手工删文件）。
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, key, { encoding: "utf8", mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    // 并发启动：另一个进程已经落盘，优先复用它，避免生成两个有效密钥。
    try {
      const existing = (await readFile(path, "utf8")).trim()
      if (ADMIN_KEY_PATTERN.test(existing)) return { value: existing, path, fromEnv: false, generated: false }
    } catch {
      // 真的读不到：把**第一次** rename 的错误抛出去，它才是根因。
    }
    throw error
  }
  return { value: key, path, fromEnv: false, generated: true }
}

/**
 * 常量时间比较。
 *
 * 先各自取 SHA-256 再比：`timingSafeEqual` 要求**两参数定长相等**，直接比字符串
 * 会因长度不同提前返回；先摘要就把长度差异吸收掉，且摘要不可逆。
 *
 * @returns 是否相等。
 */
export function constantTimeEquals(left, right) {
  const a = createHash("sha256")
    .update(String(left ?? ""))
    .digest()
  const b = createHash("sha256")
    .update(String(right ?? ""))
    .digest()
  return timingSafeEqual(a, b)
}

/**
 * 由管理密钥派生会话令牌。
 *
 * @returns base64url 令牌（无填充，可直接进 Cookie）。
 */
export function sessionToken(key) {
  return createHmac("sha256", key).update(SESSION_LABEL).digest("base64url")
}

/**
 * 解析 `Cookie` 头。
 *
 * 只做够用的事：上游页面不需要完整的 RFC 6265（不涉及引号、转义、属性）。
 *
 * @returns `name → value` 的普通对象。
 */
export function parseCookies(header) {
  const out = Object.create(null)
  if (typeof header !== "string" || header === "") return out
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (name === "") continue
    const value = part.slice(index + 1).trim()
    // 值里可能有 `=`（base64 填充）：只按第一个 `=` 切分，这里已做到。
    out[name] = decodeURIComponent(value)
  }
  return out
}

/**
 * 判断一条请求是否已通过管理端鉴权。
 *
 * 两种凭据任一命中即放行：
 * - `Authorization: Bearer <admin-key>`（脚本 / curl / 监控）；
 * - 会话 Cookie（浏览器导航与子资源）。
 *
 * @param request - node 的 `IncomingMessage`。
 * @param key - 管理密钥。
 * @returns 是否已授权。
 */
export function isAdminAuthorized(request, key) {
  if (typeof key !== "string" || key === "") return false

  const authorization = request.headers?.authorization
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    if (constantTimeEquals(authorization.slice("Bearer ".length), key)) return true
  }

  const cookies = parseCookies(request.headers?.cookie)
  const token = cookies[SESSION_COOKIE]
  if (typeof token === "string" && token !== "") {
    if (constantTimeEquals(token, sessionToken(key))) return true
  }

  return false
}

/**
 * 构造会话 Cookie。
 *
 * - `HttpOnly`：JS 读不到（XSS 拿不走，也算不出）；
 * - `SameSite=Lax`：跨站 POST 不携带，挡住最简单的 CSRF；同时不影响用户从
 *   书签 / 外链点进 `/admin`（那是顶层 GET 导航，Lax 允许）；
 * - `Path=/`：`/api/jet-hub` 与 `/admin.js` 都要带；
 * - `Secure`：仅在 HTTPS 下加。**刻意不默认开启** —— 本服务自身只提供明文
 *   HTTP，若默认带 `Secure`，用户按 README 直连 `http://ip:8080` 时浏览器
 *   会**静默不存**这个 Cookie，表现为「密码输对了但还是让我登录」，极难排查。
 *
 * @param key - 管理密钥。
 * @param options - `{ secure }`。
 */
export function sessionCookie(key, options = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionToken(key))}`,
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
  ]
  if (options.secure === true) parts.push("Secure")
  return parts.join("; ")
}

/** 让浏览器立刻丢弃会话 Cookie 的 `Set-Cookie` 值。 */
export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
}

/**
 * 判断请求是否走了 HTTPS。
 *
 * 只看连接本身是否加密（`socket.encrypted`，即 Node 的 `tls` server）。
 * **不看 `X-Forwarded-Proto`**：那个头客户端能随便写，采信它等于让别人
 * 决定我们给不给会话 Cookie 加 `Secure`；而不加 `Secure` 的后果只是
 * 「Cookie 在明文连接上也会被发送」这个已知前提，不是新暴露面。
 *
 * 反代终结 TLS 的部署下这里会返回 `false`，即会话 Cookie 不带 `Secure` 标志。
 * 这是**刻意的简化**：Cookie 仍能正常工作，只是少了这一层标记。
 */
export function isSecureRequest(request) {
  return request.socket?.encrypted === true
}

/**
 * 登录失败限速：**按来源 IP 的固定窗口计数器**。
 *
 * ## 为什么必须有
 *
 * 公网部署 + 一个 43 字符的密钥，理论上暴力破解不可行；但真正危险的场景是
 * **密钥被改成短口令**（`CODEARTS2API_ADMIN_KEY=123456`）或者根本没设时，攻击者
 * 每秒可以试上千次。限速把「猜」的成本变得不可承受，且对正常用户完全无感
 * （谁会在 10 分钟内输错 10 次？）。
 *
 * ## 为什么是固定窗口而不是令牌桶
 *
 * 这里要挡的是「持续暴力」，不是「精确限流」。固定窗口实现只有几行、无时钟
 * 依赖漂移问题，够用。窗口结束自动清零，不会永久锁死。
 *
 * ## 为什么在内存里
 *
 * 进程重启后清零 —— 可以接受（重启本来就是运维动作，且攻击者也得能触发重启）。
 * 多实例部署时每个实例各算各的，等效于把阈值乘以实例数；自用网关通常单实例。
 */
export class LoginThrottle {
  /** 窗口长度（毫秒）。 */
  windowMs
  /** 窗口内允许的失败次数。 */
  maxFailures
  /** `ip → { count, resetAt }`。 */
  entries = new Map()

  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 10 * 60 * 1000
    this.maxFailures = options.maxFailures ?? 10
  }

  /** 取某个 IP 的计数（顺手清掉过期窗口，避免 Map 无限膨胀）。 */
  entry(ip, now) {
    const found = this.entries.get(ip)
    if (found === undefined || now >= found.resetAt) {
      const fresh = { count: 0, resetAt: now + this.windowMs }
      this.entries.set(ip, fresh)
      return fresh
    }
    return found
  }

  /**
   * 该 IP 现在还能不能再尝试。
   *
   * @returns 还能尝试则 `null`；被限流则返回 `{ retryAfter }`（秒）。
   */
  check(ip, now = Date.now()) {
    const entry = this.entry(ip, now)
    if (entry.count < this.maxFailures) return null
    return { retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) }
  }

  /** 记一次失败。 */
  fail(ip, now = Date.now()) {
    this.entry(ip, now).count += 1
  }

  /** 登录成功后清零（成功即证明是本人，不该继续惩罚）。 */
  reset(ip) {
    this.entries.delete(ip)
  }
}

/**
 * 从请求里取来源 IP：**就是 TCP 对端地址**。
 *
 * 刻意不读 `X-Forwarded-For` / `X-Real-IP`：客户端能随手伪造，一换就是「一个
 * 全新的 IP」，登录限速直接失效。只有部署在自己控制的代理后面时它们才有意义，
 * 而本项目**不支持**那种形态 —— 需要反代时请让反代直接转发 TCP，别加这两类头。
 *
 * @param request - node 的 `IncomingMessage`。
 */
export function clientIp(request) {
  return request.socket?.remoteAddress ?? "unknown"
}

/** HTML 转义（登录页只需这一处，不引依赖）。 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
