/**
 * 管理端鉴权的回归测试。
 *
 * ## 为什么这组测试很重要
 *
 * 在它之前，`/admin`、`/admin.js`、`/api/jet-hub` **全部无鉴权**。而
 * `/api/jet-hub` 的 `backup.export` 能导出全部账号凭据、`gateway.getEnabled`
 * 能明文取回网关 Key —— 也就是说「公网可达」等于「账号全送」。
 *
 * 所以这里断言的不是「某个功能」，而是**三条边界**：
 *
 * 1. 该拦的都拦住了（含 `/`，它与 `/admin` 是同一个页面）；
 * 2. 该放行的没被误伤（`/healthz`、`/v1/*`、验证码载体页）；
 * 3. 鉴权机制本身不会成为新的洞（开放重定向、Cookie 伪造、暴力破解）。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { startTestApp, rpc, TEST_ADMIN_KEY } from "./helpers.mjs"

/** 需要一个「浏览器会打开的页面」的 Accept 头。 */
const BROWSER_ACCEPT = { accept: "text/html,application/xhtml+xml" }

/**
 * 管理界面受保护的路径清单。
 *
 * ⚠️ `/` 与 `/admin/` 必须在内：前者是**默认入口**（很多人直接访问根路径），
 *    后者是尾斜杠形态 —— 漏掉任何一个都等于「换个地址就绕过」。
 */
const PROTECTED_PATHS = ["/", "/admin", "/admin/", "/admin.css", "/admin-boot.js", "/admin.js", "/upstream-jet-hub.js"]

test("未登录时管理页面与静态资源全部被拦（含根路径 /）", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  for (const path of PROTECTED_PATHS) {
    const response = await fetch(`${app.origin}${path}`, {
      headers: BROWSER_ACCEPT,
      redirect: "manual",
    })
    // 浏览器形态：302 到登录页，而不是 401 JSON —— 否则用户看到满屏花括号。
    assert.equal(response.status, 302, `${path} 未登录应重定向到登录页`)
    const location = response.headers.get("location")
    assert.match(location, /^\/admin\/login\?next=/, `${path} 应跳到登录页并带上 next，实际：${location}`)
    // ⚠️ 关键：**不能**泄露页面内容。
    const body = await response.text()
    assert.equal(body, "", `${path} 的 302 不应带响应体`)
  }
})

test("未登录时管理 RPC 回 401（而不是它的数据）", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 用 curl 那种 Accept（不含 text/html）→ 应拿到 401 JSON 而不是 302。
  const response = await fetch(`${app.origin}/api/jet-hub`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "*/*" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: "x",
      method: "jet-hub",
      payload: { method: "gateway.getEnabled", payload: {} },
    }),
  })
  assert.equal(response.status, 401, "未授权的 RPC 应回 401")
  const body = await response.json()
  assert.equal(body.error, "unauthorized")
  // 绝不能把 apiKey 之类的管理数据漏出来。
  assert.equal(body.result, undefined, "401 响应里不应含 rpc result")
  assert.doesNotMatch(JSON.stringify(body), /apiKey/, "401 响应不应含网关密钥字段")
  // 点明认证方案，便于 curl 等客户端判断该怎么带凭据。
  assert.match(
    response.headers.get("www-authenticate") ?? "",
    /^Bearer /,
    "401 应带 WWW-Authenticate: Bearer（否则脚本不知道用什么方案）",
  )
})

test("错误的管理密钥被拒绝，正确的被接受", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const wrong = await rpc(app.origin, "account.list", { provider: "codearts" }, { key: "definitely-not-the-key" })
  assert.equal(wrong, undefined, "错误密钥不应拿到 rpc result")

  const correct = await rpc(app.origin, "account.list", { provider: "codearts" })
  assert.equal(correct.ok, true, "正确密钥应可调用 RPC")
})

test("放行清单：/healthz 与验证码载体页不需要鉴权", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // /healthz：监控 / 容器探活要用，且它刻意不含密钥。
  const health = await fetch(`${app.origin}/healthz`)
  assert.equal(health.status, 200)
  const body = await health.json()
  assert.equal(body.adminAuth, true, "healthz 应回显鉴权是否启用")
  assert.doesNotMatch(JSON.stringify(body), /apiKey/, "healthz 仍不应含密钥")

  // 验证码载体页：页面里只有阿里云 SDK 的公开参数，且要被 <webview> 直接导航。
  // 上游未注册它时回 404 —— 那也是「没有被 401 拦下」的证明。
  const carrier = await fetch(`${app.origin}/api/jet-hub/captcha-carrier`, { headers: BROWSER_ACCEPT })
  assert.notEqual(carrier.status, 401, "验证码载体页不应要求鉴权")
  assert.ok([200, 404].includes(carrier.status), `载体页应是 200 或 404，实际 ${carrier.status}`)
})

test("/v1/* 不受管理端鉴权影响（它有自己的 Bearer）", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 不带任何 Key：应是插件网关的 401，而**不是**管理端的 401 JSON。
  const response = await fetch(`${app.origin}/v1/models`, { headers: { accept: "*/*" } })
  assert.equal(response.status, 401, "无 Key 时网关应回 401")
  const body = await response.json()
  // 管理端的 401 长这样：{ error: "unauthorized" }；网关的是 OpenAI 错误信封。
  assert.notEqual(body.error, "unauthorized", "/v1/* 应由插件网关鉴权，而非管理端门禁")
})

test("登录表单能换到会话 Cookie，之后可直接访问页面", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // ① 拿登录页：无鉴权可达，且**不含任何密钥**。
  const page = await fetch(`${app.origin}/admin/login`, { headers: BROWSER_ACCEPT })
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /type="password"/, "登录页应有密码框")
  assert.doesNotMatch(html, new RegExp(TEST_ADMIN_KEY), "登录页绝不能回显密钥")
  // 登录页是**未认证**页面：密钥存在哪个文件、是否来自环境变量都属于部署内情。
  // 回显给任何访问者，等于替他标好了下一步（找 .env / 读日志 / 猜路径）。
  assert.doesNotMatch(html, /CODEARTS2API_ADMIN_KEY/, "登录页不应提示密钥来自环境变量")
  assert.equal(html.includes(join(app.home, "admin-key")), false, "登录页不应回显密钥文件路径")

  // ② 提交正确密钥。
  const login = await fetch(`${app.origin}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...BROWSER_ACCEPT },
    body: new URLSearchParams({ key: TEST_ADMIN_KEY, next: "/admin" }),
    redirect: "manual",
  })
  assert.equal(login.status, 303, "登录成功应 303 重定向")
  const setCookie = login.headers.get("set-cookie")
  assert.match(setCookie, /c2a_admin=/, "应下发会话 Cookie")
  assert.match(setCookie, /HttpOnly/, "会话 Cookie 必须 HttpOnly（XSS 拿不走）")
  assert.match(setCookie, /SameSite=Lax/, "会话 Cookie 应有 SameSite=Lax")
  // ⚠️ 明文 HTTP 下**不能**带 Secure，否则浏览器静默不存（表现为「登录永远不成功」）。
  assert.doesNotMatch(setCookie, /Secure/, "http 下不应带 Secure 标志")

  // ③ 带着 Cookie 访问管理页：应拿到真正的 HTML。
  const cookie = setCookie.split(";")[0]
  const admin = await fetch(`${app.origin}/admin`, { headers: { ...BROWSER_ACCEPT, cookie } })
  assert.equal(admin.status, 200, "带会话 Cookie 应能打开管理页")
  const adminHtml = await admin.text()
  assert.match(adminHtml, /admin-root/, "应返回真实的管理页面")
})

test("未授权的 401 JSON 不回显密钥位置与来源", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 脚本 / 客户端（Accept 不含 text/html）拿到的是 401 JSON —— 同样是**未认证可达**的
  // 响应面，密钥文件路径与「来自环境变量」都属于部署内情，不能写给任何访问者。
  const response = await fetch(`${app.origin}/admin`, { headers: { accept: "*/*" } })
  assert.equal(response.status, 401, "未授权的脚本请求应回 401")
  const body = await response.text()
  assert.match(body, /Authorization: Bearer/, "仍应提示 Bearer 鉴权方式")
  assert.doesNotMatch(body, /CODEARTS2API_ADMIN_KEY/, "401 响应不应提及密钥环境变量名")
  assert.doesNotMatch(body, /CODEARTS2API_HOME/, "401 响应不应暴露 home 路径变量")
  assert.equal(body.includes(join(app.home, "admin-key")), false, "401 响应不应回显密钥文件路径")
})

test("伪造的会话 Cookie 无效", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 会话令牌 = HMAC(admin-key, 常量)。不知道密钥就不可能算对。
  for (const fake of ["", "deadbeef", "x".repeat(43)]) {
    const response = await fetch(`${app.origin}/api/jet-hub`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "*/*", cookie: `c2a_admin=${fake}` },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "x",
        method: "jet-hub",
        payload: { method: "gateway.getEnabled", payload: {} },
      }),
    })
    assert.equal(response.status, 401, `伪造的 Cookie "${fake.slice(0, 12)}" 不应通过`)
  }
})

test("登录失败会限速，且 next 参数不能用于开放重定向", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // ① 连续输错：前几次回登录页（200），超过阈值后仍是 200 但提示「过于频繁」。
  let sawThrottle = false
  for (let i = 0; i < 12; i += 1) {
    const response = await fetch(`${app.origin}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...BROWSER_ACCEPT },
      body: new URLSearchParams({ key: `wrong-${i}`, next: "/admin" }),
    })
    const html = await response.text()
    if (/尝试过于频繁/.test(html)) {
      sawThrottle = true
      break
    }
  }
  assert.ok(sawThrottle, "连续输错应触发登录限速")

  // ② 限速期间**正确密钥也被挡**（否则限速可被「猜对一次」绕过）。
  const correctDuringThrottle = await fetch(`${app.origin}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...BROWSER_ACCEPT },
    body: new URLSearchParams({ key: TEST_ADMIN_KEY, next: "/admin" }),
    redirect: "manual",
  })
  assert.equal(correctDuringThrottle.status, 200, "限速期间即使密钥正确也应被挡")

  // ③ 开放重定向防护：`next` 只能是站内路径。
  const { sanitizeNext } = await import("../src/admin-login-page.js")
  for (const evil of [
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "javascript:alert(1)",
    "http://evil.com/x",
    "",
  ]) {
    assert.equal(sanitizeNext(evil), "/admin", `next=${JSON.stringify(evil)} 应被收窄为 /admin`)
  }
  assert.equal(sanitizeNext("/admin?x=1"), "/admin?x=1", "正常站内路径应保留")
})

test("管理响应带安全响应头（CSP / 防点击劫持 / 禁 MIME 嗅探）", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const page = await fetch(`${app.origin}/admin/login`, { headers: BROWSER_ACCEPT })
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/, "应有严格 CSP")
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/, "应禁 iframe 嵌套")
  assert.equal(page.headers.get("x-frame-options"), "DENY", "老浏览器兜底头")
  assert.equal(page.headers.get("x-content-type-options"), "nosniff", "应禁 MIME 嗅探")
  assert.equal(page.headers.get("referrer-policy"), "no-referrer", "不应外泄 Referer")

  // 管理页与静态资源同样要带（漏一处就是一个可被套框的页面）。
  const login = await fetch(`${app.origin}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...BROWSER_ACCEPT },
    body: new URLSearchParams({ key: TEST_ADMIN_KEY }),
    redirect: "manual",
  })
  const cookie = login.headers.get("set-cookie").split(";")[0]
  for (const path of ["/admin", "/admin.js", "/admin.css"]) {
    const response = await fetch(`${app.origin}${path}`, { headers: { ...BROWSER_ACCEPT, cookie } })
    assert.equal(response.status, 200, `${path} 应可访问`)
    assert.equal(response.headers.get("x-frame-options"), "DENY", `${path} 应带防点击劫持头`)
  }
})

test("管理密钥文件自动生成且不入库（0600 权限）", async (t) => {
  // 不带 adminKey 启动 ⇒ 走「自动生成到 home」的路径。
  const app = await startTestApp({ adminKey: "" })
  t.after(() => app.close())

  const keyPath = join(app.home, "admin-key")
  const key = readFileSync(keyPath, "utf8").trim()
  assert.match(key, /^[A-Za-z0-9_-]{43}$/, "自动生成的密钥应是 43 位 base64url")

  // 用它登录，证明「生成的文件」与「校验用的密钥」是同一把。
  const login = await fetch(`${app.origin}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...BROWSER_ACCEPT },
    body: new URLSearchParams({ key }),
    redirect: "manual",
  })
  assert.equal(login.status, 303, "生成的密钥应能登录")

  // 权限：仅属主可读写（密钥泄露 = 后台失守）。
  //
  // ⚠️ Windows 上这条**不适用**：NTFS 没有 POSIX 权限位，Node 的 `mode` 参数
  //    会被静默忽略（实测写出来是 0666）。代码里仍然写了 `mode: 0o600` ——
  //    那是给 Linux / macOS / 容器用的，Windows 用户的实际保护来自「文件在
  //    自己的用户目录下」（其他 Windows 账户默认读不到该 profile）。
  //    在这个用例里硬断言 0600 只会得到一条与产品无关的假红。
  if (process.platform !== "win32") {
    const { statSync } = await import("node:fs")
    const mode = statSync(keyPath).mode & 0o777
    assert.equal(mode, 0o600, `密钥文件权限应为 0600，实际 0${mode.toString(8)}`)
  }

  // 无论哪个平台，密钥都不能落在仓库里（`.gitignore` 只管已知路径，
  // 真正的防线是它默认在 `~/.codearts2api` 或挂载卷下）。
  assert.ok(keyPath.includes(app.home), "密钥必须在 state home 内")

  // 再次启动（同一 home）应复用同一把，而不是静默换新 —— 换新会让已登录的
  // 浏览器全部掉线，而用户无从判断原因。
  const again = await startTestApp({ home: app.home, adminKey: "" })
  t.after(() => again.close())
  assert.equal(readFileSync(keyPath, "utf8").trim(), key, "重启不应更换密钥")
})

test("伪造 X-Forwarded-For 无法绕过登录限速", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 每个请求换一个伪造的 XFF。若服务采信这个头，每次都是「新 IP」，
  // 限速永远触发不了。服务按 TCP 对端计，所以第 11 次必然被挡。
  let sawThrottle = false
  for (let i = 0; i < 14; i += 1) {
    const response = await fetch(`${app.origin}/admin/login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        "x-forwarded-for": `203.0.113.${i}`,
      },
      body: new URLSearchParams({ key: `wrong-${i}`, next: "/admin" }),
    })
    if (/尝试过于频繁/.test(await response.text())) {
      sawThrottle = true
      break
    }
  }
  assert.ok(sawThrottle, "换 X-Forwarded-For 不应绕过限速（该头不可信）")
})

test("PROXY_GATEWAY=0 时 /v1/* 回可读的 proxy_disabled 而不是裸 404", async (t) => {
  const app = await startTestApp({ proxyGateway: false })
  t.after(() => app.close())

  const response = await fetch(`${app.origin}/v1/models`, {
    headers: { accept: "*/*", authorization: "Bearer whatever" },
  })
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error.code, "proxy_disabled", "应明确告知是反代被关，而非资源不存在")
  assert.match(body.error.message, /PROXY_GATEWAY/, "错误信息应点出对应的环境变量")
})

test("CODEARTS2API_ADMIN_AUTH=0 可关闭鉴权（本机开发用）", async (t) => {
  const app = await startTestApp({ adminAuth: false })
  t.after(() => app.close())

  // 关掉后页面与 RPC 都应直接可用。
  const page = await fetch(`${app.origin}/admin`, { headers: BROWSER_ACCEPT })
  assert.equal(page.status, 200, "鉴权关闭后 /admin 应直接可访问")

  const listed = await rpc(app.origin, "account.list", { provider: "codearts" }, { authorized: false })
  assert.equal(listed.ok, true, "鉴权关闭后 RPC 应无需密钥")

  // /healthz 要如实反映「现在是裸奔状态」，便于运维发现。
  const health = await (await fetch(`${app.origin}/healthz`)).json()
  assert.equal(health.adminAuth, false, "healthz 应回显鉴权已关闭")
})
