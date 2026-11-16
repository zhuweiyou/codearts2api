/**
 * 管理端鉴权契约（新）：
 * - 页面/静态资源公开，登录界面在前端；真正需要保护的是数据/动作 API。
 * - 登录 API 用 JSON 换会话 Cookie；无 Cookie 的会话接口返回 authenticated:false。
 * - 伪造 Cookie、开放重定向、暴力破解都要挡住。
 */
import { test } from "vite-plus/test"
import assert from "node:assert/strict"

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
