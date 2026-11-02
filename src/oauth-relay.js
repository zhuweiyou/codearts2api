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

import { Readable } from "node:stream"

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

function writeHead(response, status, outHeaders) {
  response.writeHead(status, outHeaders)
}

export function createOAuthRelay(options = {}) {
  const logger = options.logger ?? console

  const uiBody = Buffer.from(UI_SRC, "utf8")

  // ── 中继：/relay/<port>/<path> → http://127.0.0.1:<port>/<path> ──
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
    const target = `http://127.0.0.1:${port}${rest}${url.search}`

    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue
      if (HOP_BY_HOP.has(key.toLowerCase())) continue
      if (key.toLowerCase() === "cookie") {
        // 去掉管理端自己的 cookie，避免把 admin 会话带给上游登录页
        const kept = String(value)
          .split(";")
          .map((item) => item.trim())
          .filter((item) => item !== "" && !/^(c2d_|c2admin|admin_)/i.test(item))
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
      if (HOP_BY_HOP.has(key.toLowerCase())) return
      if (key.toLowerCase() === "content-security-policy") return // 允许注入的补丁脚本执行
      if (key.toLowerCase() === "x-frame-options") return
      outHeaders[key] = value
    })
    outHeaders["cache-control"] = "no-store"

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

  // 3) 右下角「回调修复」挂件
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function buildPanel() {
    var style = el("style");
    style.textContent = [
      ".c2or-fab{position:fixed;right:18px;bottom:18px;z-index:2147482000;height:32px;padding:0 14px;",
      "border:1px solid #dcdfe6;border-radius:16px;background:#fff;color:#606266;font-size:12px;",
      "line-height:30px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.12);}",
      ".c2or-fab:hover{color:#409eff;border-color:#c6e2ff;}",
      ".c2or-panel{position:fixed;right:18px;bottom:60px;z-index:2147482001;width:420px;background:#fff;",
      "border:1px solid #e4e7ed;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.16);padding:14px 16px;",
      "font-size:13px;color:#303133;font-family:inherit;}",
      ".c2or-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}",
      ".c2or-hd b{font-size:13px;font-weight:600;}",
      ".c2or-x{border:0;background:none;color:#909399;font-size:16px;line-height:1;cursor:pointer;padding:0 2px;}",
      ".c2or-x:hover{color:#409eff;}",
      ".c2or-tip{color:#909399;font-size:12px;line-height:1.7;margin-bottom:8px;}",
      ".c2or-ta{width:100%;box-sizing:border-box;height:64px;resize:vertical;border:1px solid #dcdfe6;",
      "border-radius:4px;padding:6px 8px;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;",
      "color:#303133;outline:none;}",
      ".c2or-ta:focus{border-color:#409eff;}",
      ".c2or-row{display:flex;align-items:center;gap:8px;margin-top:10px;}",
      ".c2or-btn{height:28px;padding:0 14px;border-radius:4px;border:1px solid #409eff;background:#409eff;",
      "color:#fff;font-size:12px;cursor:pointer;}",
      ".c2or-btn:disabled{opacity:.6;cursor:default;}",
      ".c2or-btn.plain{background:#fff;color:#606266;border-color:#dcdfe6;}",
      ".c2or-out{margin-top:10px;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-all;}",
      ".c2or-ok{color:#67c23a;}.c2or-bad{color:#f56c6c;}.c2or-dim{color:#909399;}"
    ].join("");
    document.head.appendChild(style);

    var fab = el("button", "c2or-fab", "回调修复");
    var panel = el("div", "c2or-panel");
    var hd = el("div", "c2or-hd");
    hd.appendChild(el("b", "", "OAuth 回调修复"));
    var x = el("button", "c2or-x", "\u00d7");
    hd.appendChild(x);
    panel.appendChild(hd);
    panel.appendChild(
      el(
        "div",
        "c2or-tip",
        "把浏览器里报 ERR_CONNECTION_REFUSED 的那个地址整条粘进来，由服务器本机重放一次。"
      )
    );
    var ta = el("textarea", "c2or-ta");
    ta.placeholder = "http://127.0.0.1:41451/auth/callback?code=...&state=...";
    panel.appendChild(ta);
    var row = el("div", "c2or-row");
    var runBtn = el("button", "c2or-btn", "重放");
    var pasteBtn = el("button", "c2or-btn plain", "从剪贴板粘贴");
    row.appendChild(runBtn);
    row.appendChild(pasteBtn);
    panel.appendChild(row);
    var out = el("div", "c2or-out");
    panel.appendChild(out);

    panel.style.display = "none";
    document.body.appendChild(fab);
    document.body.appendChild(panel);

    fab.addEventListener("click", function () {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
      if (panel.style.display === "block") {
        try { ta.focus(); } catch (e) {}
      }
    });
    x.addEventListener("click", function () { panel.style.display = "none"; });

    pasteBtn.addEventListener("click", function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        out.className = "c2or-out c2or-bad";
        out.textContent = "当前浏览器不允许读剪贴板，请手动 Ctrl+V 粘贴。";
        return;
      }
      navigator.clipboard.readText().then(function (text) {
        ta.value = String(text || "").trim();
      }).catch(function () {
        out.className = "c2or-out c2or-bad";
        out.textContent = "读剪贴板被拒绝，请手动 Ctrl+V 粘贴。";
      });
    });

    runBtn.addEventListener("click", function () {
      var value = String(ta.value || "").trim();
      if (value === "") {
        out.className = "c2or-out c2or-bad";
        out.textContent = "先把回调地址粘进来。";
        return;
      }
      runBtn.disabled = true;
      out.className = "c2or-out c2or-dim";
      out.textContent = "正在由服务器本机重放…";
      fetch("/admin/oauth-relay/replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ url: value })
      }).then(function (res) {
        return res.json().then(function (data) { return { status: res.status, data: data }; });
      }).then(function (result) {
        var data = result.data || {};
        if (result.status === 200 && data.ok) {
          out.className = "c2or-out c2or-ok";
          out.textContent = "重放成功（HTTP " + data.status + "，端口 " + data.port + "）。请回到面板点「重新读取」或等待轮询自动结束。"
            + (data.snippet ? "\n\n页面提示：" + data.snippet : "");
        } else if (result.status === 200) {
          out.className = "c2or-out c2or-bad";
          out.textContent = "重放已发出但上游返回 HTTP " + data.status + "（多半是 code 无效/已用过）。"
            + (data.snippet ? "\n\n页面提示：" + data.snippet : "");
        } else {
          out.className = "c2or-out c2or-bad";
          out.textContent = (data.error || "重放失败") + (data.target ? "\n\n目标：" + data.target : "");
        }
      }).catch(function (error) {
        out.className = "c2or-out c2or-bad";
        out.textContent = "请求失败：" + String(error && error.message ? error.message : error);
      }).then(function () {
        runBtn.disabled = false;
      });
    });
  }

  function boot() {
    try {
      startObserver();
      buildPanel();
    } catch (e) {
      console.error("[oauth-relay] 面板初始化失败", e);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
`
