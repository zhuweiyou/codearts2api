// OAuth 回调中继：把上游硬绑 127.0.0.1:<随机端口> 的登录页/回调，搬到公网域名下。
//
// 背景：上游 provider 的 OAuth 回调服务器一律 server.listen(0, "127.0.0.1")，
// 监听器在**服务器**上，而回调 URL 却交给**用户浏览器**打开 ⇒ ERR_CONNECTION_REFUSED。
// 上游刻意绑回环（绑全网卡会被同局域网伪造 ?code=），所以只能在网关这层做中继。
//
// 两个入口（都在管理端鉴权门之后，未登录一律 302/401）：
//   1) GET|POST /relay/<port>/<path>  反向代理到 http://127.0.0.1:<port>/<path>
//      - HTML 会注入 fetch/XHR 前缀补丁，让页面里的 /astudio/* 这类**根相对路径**也落到中继上
//   2) POST /admin/oauth-relay/replay  把「页面上粘贴过来的失败回调 URL」在服务器本机重放一次
//      - 真 OAuth 授权码类（accio/trae/codearts/gemini/lobsterai）由第三方写死重定向到
//        http://127.0.0.1:<port>/... ，无法改写，只能靠这一招收官
//
// 安全边界：目标只允许 127.0.0.1 / localhost / [::1]，端口 1024–65535，方法只放 GET/POST/HEAD。
// 绝不代理任意外网地址（否则本文件就是一个开放代理）。
//
// 已知残留面（有意接受）：端口无法白名单化 —— OAuth 监听器由上游随机挑选端口，
// 唯一稳定的约束是「回环地址 + 1024–65535」。因此已登录的管理员在技术上可以
// 反代本机任意回环端口。这里不改判定，改为对每一次中继留审计日志（见 audit），
// 让「在什么时候打了哪个端口」可追溯。

import { Readable } from "node:stream"

import { MIN_PORT, MAX_PORT, parseLoopbackUrl, loopbackOf } from "./oauth-relay.service.ts"

import { SESSION_COOKIE } from "../auth/auth.service.ts"

export const RELAY_PREFIX = "/relay/"
export const REPLAY_PATH = "/admin/oauth-relay/replay"

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

const ALLOWED_METHODS = new Set(["GET", "POST", "HEAD"])
const REPLAY_BODY_LIMIT = 8 * 1024
const REPLAY_TIMEOUT_MS = 30_000
const PROXY_TIMEOUT_MS = 120_000
const HTML_LIMIT = 2 * 1024 * 1024

// 页面里的根相对路径补丁。fetcht/XHR 的 '/astudio/gee-captcha' 在浏览器里解析成
// https://<域名>/astudio/gee-captcha，不会自动带上 /relay/<port> 前缀，必须运行时补。
function pagePatchScript(port) {
  const prefix = `${RELAY_PREFIX}${port}`
  return [
    "<script>(function(){",
    `var P=${JSON.stringify(prefix)};`,
    "function fix(u){",
    'if(typeof u!=="string"||u==="")return u;',
    'if(u.charAt(0)!=="/")return u;',
    'if(u==="/relay/"||u.indexOf("/relay/")===0)return u;',
    "return P+u;}",
    'try{var of=window.fetch;window.fetch=function(i,o){try{if(typeof i==="string")i=fix(i);',
    'else if(i&&typeof i.url==="string"){var n=fix(i.url);if(n!==i.url)i=new Request(n,i);}}catch(e){}',
    "return of.call(window,i,o);};}catch(e){}",
    "try{var ox=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){",
    "var a=Array.prototype.slice.call(arguments);a[1]=fix(u);return ox.apply(this,a);};}catch(e){}",
    "})();</script>",
  ].join("")
}

// 静态属性里的根相对路径（src/href/action/url()）也顺手补前缀，覆盖不经过 fetch 的资源
function rewriteHtml(text, port) {
  const prefix = `${RELAY_PREFIX}${port}`
  let out = text
  out = out.replace(/\b(src|href|action)=("|')\/(?!\/|relay\/)/gi, (_m, attr, quote) => `${attr}=${quote}${prefix}/`)
  out = out.replace(/url\((["']?)\/(?!\/|relay\/)/gi, (_m, quote) => `url(${quote}${prefix}/`)
  const patch = pagePatchScript(port)
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + patch)
  else out = patch + out
  return out
}

function readRequestBody(request, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(null)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => finish(Buffer.concat(chunks).toString("utf8")))
    request.on("error", () => finish(null))
  })
}

/**
 * 把上游 Set-Cookie 的 Path 挂到该端口的中继前缀下。
 * 没写 Path 或 Path=/ 时铺满这个端口的中继空间，保证同一监听器的后续请求都带得上。
 */
function rewriteCookiePath(cookie, port) {
  const prefix = RELAY_PREFIX + port
  const match = /;\s*path=([^;]*)/i.exec(cookie)
  const raw = String(match && match[1] ? match[1] : "").trim()
  const target = raw === "" || raw === "/" ? prefix + "/" : prefix + (raw.startsWith("/") ? raw : "/" + raw)
  if (!match) return cookie + "; Path=" + target
  return cookie.slice(0, match.index) + "; Path=" + target + cookie.slice(match.index + match[0].length)
}

function writeHead(response, status, outHeaders) {
  response.writeHead(status, outHeaders)
}

export function createOAuthRelay(options: any = {}) {
  const logger = options.logger ?? console

  // ── 中继：/relay/<port>/<path> → http://127.0.0.1:<port>/<path> ──
  /**
   * 中继审计：记录每一次转发尝试。
   *
   * 只记「方法 + 目标端口 + 路径」，不记 header / body —— 回调 URL 的 query 里
   * 就带 `code`，写进日志等于把一次性授权码长期留档。
   */
  function audit(method, port, rest) {
    logger?.info?.(`[oauth-relay] 审计 中继 ${method} → 127.0.0.1:${port}${rest}`)
  }

  async function proxy(request, response, url) {
    if (!ALLOWED_METHODS.has(request.method ?? "GET")) {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" })
      response.end("Method Not Allowed")
      return
    }
    const match = /^\/relay\/(\d{1,5})(\/.*)?$/.exec(url.pathname)
    if (!match) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
      response.end("中继地址格式应为 /relay/<port>/<path>")
      return
    }
    const port = Number(match[1])
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
      response.end("端口超出允许范围（1024–65535）")
      return
    }
    const rest = match[2] ?? "/"
    audit(request.method ?? "GET", port, rest)
    const target = `http://127.0.0.1:${port}${rest}${url.search}`

    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue
      if (HOP_BY_HOP.has(key.toLowerCase())) continue
      // 管理端会话凭证一律不下发给回环上游。
      if (key.toLowerCase() === "authorization") continue
      if (key.toLowerCase() === "cookie") {
        // 去掉管理端自己的 cookie，避免把 admin 会话带给上游登录页
        const kept = String(value)
          .split(";")
          .map((item) => item.trim())
          .filter((item) => item !== "" && !item.startsWith(SESSION_COOKIE + "="))
          .join("; ")
        if (kept !== "") headers.set(key, kept)
        continue
      }
      if (Array.isArray(value)) headers.set(key, value.join(", "))
      else headers.set(key, String(value))
    }

    const method = request.method ?? "GET"
    const hasBody = method !== "GET" && method !== "HEAD"

    let upstream
    try {
      upstream = await fetch(target, {
        method,
        headers,
        body: hasBody ? request : undefined,
        ...(hasBody ? { duplex: "half" } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      })
    } catch (error) {
      logger?.error?.(`[oauth-relay] 中继失败 ${target}：${String(error)}`)
      const body = Buffer.from(
        `本机 ${port} 端口的登录页已不可达（可能已超时或被上游关闭）。\n\n` +
          `原始错误：${String(error)}\n\n` +
          `请回到面板重新点击「+ 新建账号」；若已经拿到回调链接，改用「回调修复」里的重放。`,
        "utf8",
      )
      writeHead(response, 502, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(body.length),
        "cache-control": "no-store",
      })
      response.end(body)
      return
    }

    const outHeaders = {}
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower)) return
      if (lower === "content-security-policy") return // 允许注入的补丁脚本执行
      if (lower === "x-frame-options") return
      // forEach 会把多枚 set-cookie 合并成一条，必须单独逐条取。
      if (lower === "set-cookie") return
      outHeaders[key] = value
    })
    outHeaders["cache-control"] = "no-store"
    // 上游登录页给自己种 cookie 时 Path 常写死模块路径，不改到中继前缀下的话
    // 浏览器会把它记到面板自己的路径上，后续请求根本带不回监听器。
    const upstreamCookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : []
    if (upstreamCookies.length > 0) {
      outHeaders["set-cookie"] = upstreamCookies.map((cookie) => rewriteCookiePath(cookie, port))
    }
    // 站内跳转不带前缀就会跳出中继空间（面板根路径没有这个路由，直接 404）。
    const upstreamLocation = outHeaders["location"]
    if (typeof upstreamLocation === "string" && upstreamLocation.startsWith("/")) {
      outHeaders["location"] = RELAY_PREFIX + port + upstreamLocation
    }

    const contentType = upstream.headers.get("content-type") ?? ""
    if (contentType.includes("text/html") && upstream.body !== null) {
      // HTML 需要改写：先整体读出（登录页体积很小），注入补丁脚本后再回写
      let html
      try {
        html = await upstream.text()
      } catch (error) {
        html = `<pre>读取上游登录页失败：${String(error)}</pre>`
      }
      if (html.length > HTML_LIMIT) html = html.slice(0, HTML_LIMIT)
      const body = Buffer.from(rewriteHtml(html, port), "utf8")
      delete outHeaders["content-length"]
      delete outHeaders["content-encoding"]
      writeHead(response, upstream.status, outHeaders)
      response.end(body)
      return
    }

    writeHead(response, upstream.status, outHeaders)
    if (upstream.body === null) {
      response.end()
      return
    }
    const stream = Readable.fromWeb(upstream.body)
    response.once("close", () => {
      if (!response.writableEnded) stream.destroy()
    })
    stream.on("error", () => response.destroy())
    stream.pipe(response)
  }

  // ── 重放：POST /admin/oauth-relay/replay  { url } ──
  async function replay(request, response) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "只接受 POST" })
      return
    }
    const raw = await readRequestBody(request, REPLAY_BODY_LIMIT)
    if (raw === null) {
      sendJson(response, 413, { error: `请求体过大（上限 ${REPLAY_BODY_LIMIT} 字节）` })
      return
    }
    let payload: any
    try {
      payload = JSON.parse((raw as string) || "{}")
    } catch {
      sendJson(response, 400, { error: "请求体不是合法 JSON" })
      return
    }
    const parsed = parseLoopbackUrl(payload?.url)
    if (parsed === null) {
      sendJson(response, 400, {
        error: "只接受本机回调地址：http://127.0.0.1:<端口>/... 或 http://localhost:<端口>/...（端口 1024–65535）",
      })
      return
    }
    const target = loopbackOf(parsed)
    let upstream
    try {
      upstream = await fetch(target, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
      })
    } catch (error) {
      logger?.error?.(`[oauth-relay] 重放失败 ${target}：${String(error)}`)
      sendJson(response, 502, {
        ok: false,
        port: parsed.port,
        target,
        error: `本机 ${parsed.port} 端口已不可达（监听器可能已关闭）。请回到面板重新点击「+ 新建账号」，拿到新的回调链接再重放。原始错误：${String(error)}`,
      })
      return
    }
    let snippet
    try {
      const text = await upstream.text()
      snippet = text
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600)
    } catch {
      snippet = ""
    }
    logger?.info?.(`[oauth-relay] 重放 ${target} → ${upstream.status}`)
    sendJson(response, 200, { ok: upstream.ok, status: upstream.status, port: parsed.port, target, snippet })
  }

  async function handle(request, response, url) {
    try {
      if (url.pathname.startsWith(RELAY_PREFIX)) {
        await proxy(request, response, url)
        return true
      }
      if (url.pathname === REPLAY_PATH) {
        await replay(request, response)
        return true
      }
      return false
    } catch (error) {
      // 异常不能外溢：server.ts 外层兜底会把它变成 500 并丢掉中继语义
      logger?.error?.(`[oauth-relay] 处理 ${url.pathname} 失败：${String(error)}`)
      if (!response.headersSent) sendJson(response, 500, { error: String(error) })
      else response.end()
      return true
    }
  }

  return { handle }
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8")
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  })
  response.end(body)
}
