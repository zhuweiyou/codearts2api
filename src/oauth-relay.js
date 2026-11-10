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

import { SESSION_COOKIE } from "./admin-auth.js"

export const UI_PATH = "/admin/oauth-relay-ui.js"
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
const HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])
const MIN_PORT = 1024
const MAX_PORT = 65535
const REPLAY_BODY_LIMIT = 8 * 1024
const REPLAY_TIMEOUT_MS = 30_000
const PROXY_TIMEOUT_MS = 120_000
const HTML_LIMIT = 2 * 1024 * 1024

// 解析 "http://127.0.0.1:41451/auth/callback?code=..&state=.."
// 也接受裸的 "127.0.0.1:41451/auth/callback"（用户从地址栏复制时常常丢掉协议头）
export function parseLoopbackUrl(raw) {
  if (typeof raw !== "string") return null
  const text = raw.trim()
  if (text === "") return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (!HOSTS.has(url.hostname)) return null
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null
  return { host: url.hostname, port, path: url.pathname || "/", search: url.search || "", href: url.href }
}

// 把浏览器地址栏里那个 https://api.321ds.cn/relay/<port>/... 还原成 loopback 地址
export function loopbackOf(parsed) {
  return `http://${parsed.host}:${parsed.port}${parsed.path}${parsed.search}`
}

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

export function createOAuthRelay(options = {}) {
  const logger = options.logger ?? console

  const uiBody = Buffer.from(UI_SRC, "utf8")

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
    let payload
    try {
      payload = JSON.parse(raw || "{}")
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
      if (url.pathname === UI_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" })
          response.end("Method Not Allowed")
          return true
        }
        response.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "content-length": String(uiBody.length),
          "cache-control": "no-store",
        })
        response.end(request.method === "HEAD" ? undefined : uiBody)
        return true
      }
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
      // 异常不能外溢：server.js 外层兜底会把它变成 500 并丢掉中继语义
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

// 面板里的小挂件：①自动把 window.open / 手动链接改到中继 ②粘贴回调链接一键重放
// 注意：本段整体包在 String.raw 里，**内部不允许出现反引号**
export const UI_SRC = String.raw`(function () {
  "use strict";
  if (window.__c2OAuthRelayLoaded) return;
  window.__c2OAuthRelayLoaded = true;

  var LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})(\/[^\s]*)?$/i;

  function relayOf(raw) {
    if (typeof raw !== "string" || raw === "") return raw;
    var m = LOOPBACK.exec(raw.trim());
    if (!m) return raw;
    var rest = m[3] || "/";
    return location.origin + "/relay/" + m[2] + rest;
  }
  window.__c2RelayOf = relayOf;

  // 1) 改写 window.open：上游一律 window.open(loginUrl, "_blank", "width=800,height=600")
  var rawOpen = window.open;
  window.open = function (url, name, features) {
    try {
      return rawOpen.call(window, relayOf(url), name, features);
    } catch (e) {
      return rawOpen.call(window, url, name, features);
    }
  };

  // 2) 改写页面上已经渲染出来的 loopback 链接/文本（「手动链接」那一段）
  function fixNode(root) {
    if (!root || !root.querySelectorAll) return;
    var links = root.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href");
      var next = relayOf(href);
      if (next !== href) {
        links[i].setAttribute("href", next);
        try { links[i].dataset.c2Relayed = "1"; } catch (e) {}
      }
    }
    var codes = root.querySelectorAll("code,pre,span,div");
    for (var j = 0; j < codes.length; j++) {
      var node = codes[j];
      if (node.childElementCount !== 0) continue;
      var text = node.textContent;
      if (!text || text.indexOf("://") < 0) continue;
      var trimmed = text.trim();
      var swapped = relayOf(trimmed);
      if (swapped !== trimmed) node.textContent = text.replace(trimmed, swapped);
    }
  }

  var timer = 0;
  function schedule() {
    if (timer) return;
    // 用 setTimeout 而不是 requestAnimationFrame：页面最小化后 rAF 不触发，会把标记卡死
    timer = setTimeout(function () {
      timer = 0;
      try { fixNode(document.body); } catch (e) {}
    }, 0);
  }

  function startObserver() {
    try {
      var mo = new MutationObserver(schedule);
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (e) {}
    schedule();
  }

  var MIN_PORT = 1024;
  var MAX_PORT = 65535;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function inspect(raw) {
    var text = String(raw || "").trim();
    if (text === "") return { state: "empty" };
    var m = LOOPBACK.exec(text);
    if (!m) {
      return {
        state: "bad",
        reason: "这不是本机回调地址：应以 http://127.0.0.1:端口/ 或 http://localhost:端口/ 开头。" +
          "请复制浏览器地址栏里报「无法访问」的那一整条。",
      };
    }
    var port = Number(m[2]);
    if (!(port >= MIN_PORT && port <= MAX_PORT)) {
      return { state: "bad", reason: "端口 " + m[2] + " 超出允许范围（1024–65535）。" };
    }
    var rest = m[3] || "/";
    var q = rest.indexOf("?");
    var path = q >= 0 ? rest.slice(0, q) : rest;
    var query = q >= 0 ? rest.slice(q + 1) : "";
    var hasCode = /(^|&)code=/.test(query);
    return { state: "ok", url: text, port: port, path: path, hasCode: hasCode };
  }

  function callout(tone, title, lines) {
    var box = el("div", "c2-callout");
    box.setAttribute("data-tone", tone);
    box.appendChild(el("strong", "", title));
    (lines || []).forEach(function (line) {
      if (line) box.appendChild(el("div", "", line));
    });
    return box;
  }

  function snippetLine(data) {
    return data && data.snippet ? "页面提示：" + data.snippet : "";
  }

  function openRelayModal() {
    var shell = window.__c2Shell;
    if (!shell) return;

    var body = el("div");
    var steps = el("ol", "c2-steps");
    steps.innerHTML =
      "<li>在「渠道管理」里点对应渠道的「+ 新建账号」，在弹出的官方页面完成登录。</li>" +
      "<li>登录后浏览器会跳到 <code>http://127.0.0.1:端口/…</code> 并提示无法访问 —— 这是正常的：" +
      "那个端口开在服务器上，不在你的电脑上。</li>" +
      "<li>把地址栏里的<strong>完整地址</strong>复制下来粘到这里，点「重放」，由服务器在本机替你访问一次。</li>";
    body.appendChild(steps);

    var field = el("div", "c2-field");
    var label = el("label", "c2-label", "回调地址");
    label.setAttribute("for", "c2or-url");
    var ta = el("textarea", "c2-textarea");
    ta.id = "c2or-url";
    ta.spellcheck = false;
    ta.setAttribute("autocomplete", "off");
    ta.placeholder = "http://127.0.0.1:41451/auth/callback?code=...&state=...";
    var check = el("p", "c2-hint");
    check.setAttribute("aria-live", "polite");
    field.appendChild(label);
    field.appendChild(ta);
    field.appendChild(check);
    body.appendChild(field);

    var out = el("div");
    out.setAttribute("aria-live", "polite");
    body.appendChild(out);

    var pasteBtn = el("button", "c2-btn", "从剪贴板粘贴");
    pasteBtn.type = "button";
    var runBtn = el("button", "c2-btn c2-btn--primary", "重放");
    runBtn.type = "button";
    runBtn.disabled = true;

    var busy = false;

    function refreshCheck() {
      var info = inspect(ta.value);
      ta.removeAttribute("aria-invalid");
      check.style.color = "";
      if (info.state === "empty") {
        check.textContent = "粘贴后会先在这里检查一遍格式。";
      } else if (info.state === "bad") {
        ta.setAttribute("aria-invalid", "true");
        check.style.color = "var(--c2-err)";
        check.textContent = info.reason;
      } else {
        check.textContent = "识别到：端口 " + info.port + " · 路径 " + info.path +
          (info.hasCode ? " · 带授权码" : " · 未带 code 参数（个别渠道的回调本来就没有）");
      }
      runBtn.disabled = busy || info.state !== "ok";
      return info;
    }

    ta.addEventListener("input", function () {
      out.innerHTML = "";
      refreshCheck();
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !runBtn.disabled) {
        e.preventDefault();
        runBtn.click();
      }
    });

    pasteBtn.addEventListener("click", function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        out.innerHTML = "";
        out.appendChild(callout("warn", "浏览器不允许读剪贴板", ["请点进输入框后按 Ctrl+V 粘贴。"]));
        ta.focus();
        return;
      }
      navigator.clipboard.readText().then(function (text) {
        ta.value = String(text || "").trim();
        out.innerHTML = "";
        refreshCheck();
        ta.focus();
      }).catch(function () {
        out.innerHTML = "";
        out.appendChild(callout("warn", "读剪贴板被拒绝", ["请点进输入框后按 Ctrl+V 粘贴。"]));
        ta.focus();
      });
    });

    runBtn.addEventListener("click", function () {
      var info = refreshCheck();
      if (info.state !== "ok") return;
      busy = true;
      runBtn.disabled = true;
      runBtn.textContent = "重放中…";
      out.innerHTML = "";
      out.appendChild(callout("info", "正在由服务器本机重放…", []));
      fetch("/admin/oauth-relay/replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ url: info.url }),
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { status: res.status, data: data || {} };
        });
      }).then(function (result) {
        var data = result.data;
        out.innerHTML = "";
        if (result.status === 200 && data.ok) {
          ta.value = "";
          refreshCheck();
          out.appendChild(callout("ok", "登录回调已送达（HTTP " + data.status + "，端口 " + data.port + "）", [
            "回到「渠道管理」，对应渠道的账号列表会自动出现新账号；没出现就点该渠道的刷新按钮。",
            "输入框里的授权码已清空。",
            snippetLine(data),
          ]));
        } else if (result.status === 200) {
          out.appendChild(callout("warn", "回调已送到，但登录服务没接受（HTTP " + data.status + "）", [
            "授权码通常只能用一次、几分钟内就过期。回到对应渠道重新点「+ 新建账号」登录，拿到新地址再来。",
            snippetLine(data),
          ]));
        } else if (result.status === 502) {
          out.appendChild(callout("err", "服务器上的登录监听已经关闭", [
            data.error || "回到对应渠道重新点「+ 新建账号」，再用新跳出来的地址重试。",
          ]));
        } else {
          out.appendChild(callout("err", "重放失败", [
            data.error || "HTTP " + result.status,
            data.target ? "目标：" + data.target : "",
          ]));
        }
      }).catch(function (error) {
        out.innerHTML = "";
        out.appendChild(callout("err", "请求没有发出去", [String(error && error.message ? error.message : error)]));
      }).then(function () {
        busy = false;
        runBtn.textContent = "重放";
        refreshCheck();
      });
    });

    refreshCheck();
    shell.openModal({
      title: "OAuth 回调修复",
      subtitle: "远程部署时，第三方登录跳回 127.0.0.1 打不开？把那个地址交给服务器重放",
      body: body,
      footer: [pasteBtn, runBtn],
      initialFocus: "#c2or-url",
    });
  }

  function boot() {
    try {
      startObserver();
    } catch (e) {
      console.error("[oauth-relay] 地址改写初始化失败", e);
    }
    if (window.__c2Shell) {
      window.__c2Shell.registerAction({
        id: "oauth-relay",
        label: "回调修复",
        icon: "↺",
        title: "远程部署时，第三方登录跳回 127.0.0.1 打不开？把那个地址粘进来，由服务器在本机重放",
        onClick: openRelayModal,
      });
    } else {
      console.error("[oauth-relay] 外壳 admin-shell.js 未加载，回调修复入口无处挂载");
    }
  }
  window.__c2OpenOAuthRelay = openRelayModal;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
`
