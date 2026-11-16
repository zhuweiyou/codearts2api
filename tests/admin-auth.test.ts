/**
 * 管理端鉴权契约（新）：
 * - 页面/静态资源公开，登录界面在前端；真正需要保护的是数据/动作 API。
 * - 登录 API 用 JSON 换会话 Cookie；无 Cookie 的会话接口返回 authenticated:false。
 * - 伪造 Cookie、开放重定向、暴力破解都要挡住。
 */
import { test } from "vite-plus/test"
import assert from "node:assert/strict"

import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { sanitizeNext } from "../src/core/safe-next.ts"
import { startTestApp } from "./helpers"

const TEST_ADMIN_KEY = "test-admin-key"
const HTML_ACCEPT = { accept: "text/html,application/xhtml+xml" }
const JSON_ACCEPT = { accept: "application/json" }

const PROTECTED_APIS = [
  "/admin/callers/api/state",
  "/admin/dashboard/api",
  "/admin/models/api/opencode",
  "/admin/oauth-relay/replay",
  "/relay/12345/",
  "/api/jet-hub",
]

async function login(app: any, key: string, next = "/admin/overview") {
  return fetch(`${app.origin}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ key, next }),
  })
}

function sessionCookieOf(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? ""
  return setCookie.split(";")[0]
}

test("未登录访问受保护 API：脚本 401、浏览器 302 到前端登录页", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  for (const path of PROTECTED_APIS) {
    const script = await fetch(`${app.origin}${path}`, { headers: JSON_ACCEPT })
    assert.equal(script.status, 401, `${path} 未登录应 401`)

    const browser = await fetch(`${app.origin}${path}`, { headers: HTML_ACCEPT, redirect: "manual" })
    assert.equal(browser.status, 302, `${path} 浏览器应重定向登录页`)
    assert.match(browser.headers.get("location") ?? "", /^\/admin\/login\?next=/, `${path} 应跳到 /admin/login?next=`)
  }
})

test("页面与静态资源公开（登录界面在前端）", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  for (const path of ["/admin", "/admin/login", "/admin/overview"]) {
    const page = await fetch(`${app.origin}${path}`, { headers: HTML_ACCEPT })
    assert.equal(page.status, 200, `${path} 应公开返回 SPA`)
    assert.match(page.headers.get("content-type") ?? "", /text\/html/, `${path} 应是 HTML`)
  }
  const health = await fetch(`${app.origin}/healthz`, { headers: JSON_ACCEPT })
  assert.equal(health.status, 200)
})

test("会话接口：无 Cookie → false；登录后 → true", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  const anonymous = await fetch(`${app.origin}/admin/api/session`, { headers: JSON_ACCEPT })
  assert.equal(anonymous.status, 200)
  assert.deepEqual(await anonymous.json(), { authenticated: false })

  const response = await login(app, TEST_ADMIN_KEY)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.next, "/admin/overview")
  const setCookie = response.headers.get("set-cookie") ?? ""
  assert.match(setCookie, /c2a_admin=/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.doesNotMatch(setCookie, /Secure/, "http 下不应带 Secure")

  const cookie = sessionCookieOf(response)
  const session = await fetch(`${app.origin}/admin/api/session`, { headers: { ...JSON_ACCEPT, cookie } })
  assert.deepEqual(await session.json(), { authenticated: true })

  const state = await fetch(`${app.origin}/admin/callers/api/state`, { headers: { ...JSON_ACCEPT, cookie } })
  assert.equal(state.status, 200, "带会话 Cookie 应能访问受保护 API")
})

test("会话接口只认 Cookie，不接受 Bearer（防无限猜管理密钥）", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  // 正确密钥也不行：/admin/api/session 是公开接口，若接受 Bearer 就会绕开
  // adminGuard 的失败限速，成为可以无限试密钥的 oracle。
  for (const key of [TEST_ADMIN_KEY, "wrong-key"]) {
    const response = await fetch(`${app.origin}/admin/api/session`, {
      headers: { ...JSON_ACCEPT, authorization: `Bearer ${key}` },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { authenticated: false }, "Bearer 不应让会话接口返回 true")
  }
})

test("密码错误回 401，且不回显密钥位置/来源", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  const response = await login(app, "wrong-key")
  assert.equal(response.status, 401)
  const text = JSON.stringify(await response.json())
  assert.doesNotMatch(text, /CODEARTS2API_ADMIN_KEY/)
  assert.doesNotMatch(text, /CODEARTS2API_HOME/)
})

test("伪造的会话 Cookie 无效", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  for (const fake of ["deadbeef", "x".repeat(43)]) {
    const session = await fetch(`${app.origin}/admin/api/session`, {
      headers: { ...JSON_ACCEPT, cookie: `c2a_admin=${fake}` },
    })
    assert.deepEqual(await session.json(), { authenticated: false })

    const api = await fetch(`${app.origin}/admin/callers/api/state`, {
      headers: { ...JSON_ACCEPT, cookie: `c2a_admin=${fake}` },
    })
    assert.equal(api.status, 401)
  }
})

test("登录失败限速：超过阈值后即使密钥正确也 429", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  for (let i = 0; i < 10; i += 1) {
    const response = await login(app, `wrong-${i}`)
    assert.equal(response.status, 401)
  }
  const blocked = await login(app, TEST_ADMIN_KEY)
  assert.equal(blocked.status, 429, "限速期间应 429")
})

test("登出清除 Cookie", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  const response = await login(app, TEST_ADMIN_KEY)
  const cookie = sessionCookieOf(response)
  const out = await fetch(`${app.origin}/admin/logout`, { method: "POST", headers: { ...JSON_ACCEPT, cookie } })
  assert.equal(out.status, 200)
  assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/)

  // 登出有副作用：GET 不能清 Cookie（避免跨站图片/链接触发）。
  const getOut = await fetch(`${app.origin}/admin/logout`, { headers: JSON_ACCEPT })
  assert.equal(getOut.status, 405)
})

test("sanitizeNext 只放行站内绝对路径", () => {
  for (const evil of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", ""]) {
    assert.equal(sanitizeNext(evil), "/admin/overview", `next=${JSON.stringify(evil)} 应回落`)
  }
  assert.equal(sanitizeNext("/admin/callers?tab=keys"), "/admin/callers?tab=keys")
})

test("管理页面带安全响应头（CSP / 防点击劫持 / 禁 MIME 嗅探）", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  const page = await fetch(`${app.origin}/admin`, { headers: HTML_ACCEPT })
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/)
  assert.equal(page.headers.get("x-frame-options"), "DENY")
  assert.equal(page.headers.get("x-content-type-options"), "nosniff")
})

test("大小写变体也必须被拦截（P0 回归）", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  for (const path of ["/Admin/Callers/Api/state", "/ADMIN/models/api/opencode", "/API/jet-hub", "/Relay/12345/"]) {
    const response = await fetch(`${app.origin}${path}`, { headers: JSON_ACCEPT })
    assert.equal(response.status, 401, `${path} 大小写变体也必须 401`)
  }
})

test("未知管理 API 默认受保护；登录后未知 API 回 404 JSON（不回退 SPA）", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  const anonymous = await fetch(`${app.origin}/admin/callers/api/stat`, { headers: JSON_ACCEPT })
  assert.equal(anonymous.status, 401)

  const response = await login(app, TEST_ADMIN_KEY)
  const cookie = sessionCookieOf(response)
  const unknown = await fetch(`${app.origin}/admin/callers/api/stat`, { headers: { ...JSON_ACCEPT, cookie } })
  assert.equal(unknown.status, 404)
  assert.match(unknown.headers.get("content-type") ?? "", /application\/json/)

  const traversal = await fetch(`${app.origin}/admin/callers/api/state?day=..%2Fsecret`, {
    headers: { ...JSON_ACCEPT, cookie },
  })
  assert.equal(traversal.status, 200)
  const body = await traversal.json()
  assert.doesNotMatch(String(body.usage?.day ?? ""), /\.\.|\//)
})

test("管理密钥文件自动生成、权限 0600 且可重启复用", async (t) => {
  const app = await startTestApp({ adminKey: "" })
  const keyPath = join(app.home, "admin-key")
  const generated = (await readFile(keyPath, "utf8")).trim()
  assert.match(generated, /^[A-Za-z0-9_-]{43}$/)
  if (process.platform !== "win32") {
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600)
  }
  const used = await login(app, generated)
  assert.equal(used.status, 200)
  await app.close()

  const restarted = await startTestApp({ home: app.home, adminKey: "" })
  t.onTestFinished(() => restarted.close())
  assert.equal((await readFile(keyPath, "utf8")).trim(), generated, "重启应复用同一密钥")
  assert.equal((await login(restarted, generated)).status, 200)
})

test("CODEARTS2API_ADMIN_AUTH=0：会话视为已登录、API 直通", async (t) => {
  const app = await startTestApp({ adminAuth: false })
  t.onTestFinished(() => app.close())

  const session = await fetch(`${app.origin}/admin/api/session`, { headers: JSON_ACCEPT })
  assert.deepEqual(await session.json(), { authenticated: true })
  const state = await fetch(`${app.origin}/admin/callers/api/state`, { headers: JSON_ACCEPT })
  assert.equal(state.status, 200)
})

test("伪造 X-Forwarded-For 不能绕过登录限速", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  for (let i = 0; i < 10; i += 1) {
    const response = await fetch(`${app.origin}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-forwarded-for": `10.0.0.${i}` },
      body: JSON.stringify({ key: `wrong-${i}` }),
    })
    assert.equal(response.status, 401)
  }
  assert.equal((await login(app, TEST_ADMIN_KEY)).status, 429, "换 XFF 也应仍被限速")
})

test("Bearer 猜管理密钥同样受限速", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  let last = 401
  for (let i = 0; i < 11; i += 1) {
    const response = await fetch(`${app.origin}/admin/callers/api/state`, {
      headers: { accept: "application/json", authorization: `Bearer guess-${i}` },
    })
    last = response.status
  }
  assert.equal(last, 429)
})

test("畸形 Cookie 不会 500（parseCookies 容错）", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  const response = await fetch(`${app.origin}/admin/api/session`, {
    headers: { ...JSON_ACCEPT, cookie: "foo=%" },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { authenticated: false })
})

test("PROXY_GATEWAY=0 时 /v1 返回 404 proxy_disabled 信封", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY, proxyGateway: false })
  t.onTestFinished(() => app.close())

  const response = await fetch(`${app.origin}/v1/models`, { headers: JSON_ACCEPT })
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error.code, "proxy_disabled")
})

test("sanitizeNext 拒绝控制字符/反斜杠", () => {
  for (const evil of ["/\t/evil.com", "/\n/evil.com", "/\\evil.com", "/ /evil.com"]) {
    assert.equal(sanitizeNext(evil), "/admin/overview", `next=${JSON.stringify(evil)} 应回落`)
  }
})
