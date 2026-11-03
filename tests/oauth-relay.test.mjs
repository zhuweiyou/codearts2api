/**
 * OAuth 回调中继的回归测试。
 *
 * ## 为什么这组测试很重要
 *
 * 中继把**服务器本机**的回环端口反代到公网域名下。它有两个方向的风险：
 *
 * 1. 放开太多 —— 一旦接受任意外网地址或任意端口，`/relay/*` 就是一个开放代理；
 * 2. 漏了鉴权 —— `/relay/*` 若绕过管理端鉴权门，等于把本机所有 OAuth 监听器
 *    （含它们的 `?code=`）暴露给整个互联网。
 *
 * 所以这里断言的是**拒绝的边界**，而不是「中继能用」：
 * 非回环地址、越界端口、非 http(s) 协议、非 GET/POST/HEAD 方法必须全部被挡。
 *
 * 注意：这里不测试「中继成功的响应改写」——那需要一个真的在回环端口上
 * 服务的假上游，属于集成测试；本文件守的是安全边界与错误分支。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestApp } from "./helpers.mjs"
import { parseLoopbackUrl, loopbackOf } from "../src/oauth-relay.js"

const BROWSER_ACCEPT = { accept: "text/html,application/xhtml+xml" }

test("parseLoopbackUrl 只接受回环地址与 1024–65535 端口", () => {
  // 正常形态。
  const full = parseLoopbackUrl("http://127.0.0.1:41451/auth/callback?code=abc&state=xyz")
  assert.deepEqual(full, {
    host: "127.0.0.1",
    port: 41451,
    path: "/auth/callback",
    search: "?code=abc&state=xyz",
    href: "http://127.0.0.1:41451/auth/callback?code=abc&state=xyz",
  })
  assert.equal(loopbackOf(full), "http://127.0.0.1:41451/auth/callback?code=abc&state=xyz")

  // 用户从地址栏复制时常丢掉协议头，必须能补全。
  const bare = parseLoopbackUrl("127.0.0.1:41451/callback")
  assert.equal(bare.host, "127.0.0.1")
  assert.equal(bare.port, 41451)
  assert.equal(loopbackOf(bare), "http://127.0.0.1:41451/callback")

  // 三种回环主机名都认。
  assert.equal(parseLoopbackUrl("http://localhost:8080/x")?.host, "localhost")
  assert.equal(parseLoopbackUrl("http://[::1]:8080/x")?.host, "[::1]")
  assert.equal(parseLoopbackUrl("https://127.0.0.1:20000/x")?.port, 20000)

  // ⚠️ 外网、内网其它地址、非 http(s)、越界端口、空值 —— 一律 null。
  //    这条是本文件的核心：任何一个放过去，/relay/* 就成了开放代理。
  const rejected = [
    "http://example.com:8080/x",
    "http://api.321ds.cn:8080/x",
    "http://192.168.1.10:8080/x",
    "http://10.0.0.1:8080/x",
    "ftp://127.0.0.1:8080/x",
    "file://127.0.0.1:8080/x",
    "http://127.0.0.1:80/x",
    "http://127.0.0.1:1023/x",
    "http://127.0.0.1:70000/x",
    "http://127.0.0.1/x",
    "",
    "   ",
  ]
  for (const raw of rejected) {
    assert.equal(parseLoopbackUrl(raw), null, `${raw} 应被拒绝`)
  }
  for (const raw of [null, undefined, 42, {}, []]) {
    assert.equal(parseLoopbackUrl(raw), null, `${String(raw)} 应被拒绝`)
  }
})

test("/relay/* 未登录必须被管理端鉴权门拦下（浏览器 302，脚本 401）", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 浏览器形态：302 到登录页。
  const browser = await fetch(`${app.origin}/relay/41451/auth/callback?code=abc`, {
    headers: BROWSER_ACCEPT,
    redirect: "manual",
  })
  assert.equal(browser.status, 302)

  // 脚本/curl 形态：401 JSON（而不是把中继页面吐出去）。
  const script = await fetch(`${app.origin}/relay/41451/auth/callback?code=abc`, { redirect: "manual" })
  assert.equal(script.status, 401)
})

test("中继路由的地址与端口校验（已登录）", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const auth = { authorization: `Bearer ${app.adminKey}` }

  // 格式不对（端口段缺失/非数字）。
  const bad = await fetch(`${app.origin}/relay/abc/x`, { headers: auth })
  assert.equal(bad.status, 400)
  assert.match(await bad.text(), /中继地址格式应为/)

  // 端口越界。
  const low = await fetch(`${app.origin}/relay/80/x`, { headers: auth })
  assert.equal(low.status, 400)
  assert.match(await low.text(), /端口超出允许范围/)

  // 方法不许。
  const del = await fetch(`${app.origin}/relay/41451/x`, { method: "DELETE", headers: auth })
  assert.equal(del.status, 405)
})

test("replay 只接受 POST、合法 JSON 与本机回调地址", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const auth = { authorization: `Bearer ${app.adminKey}` }
  const endpoint = `${app.origin}/admin/oauth-relay/replay`

  const get = await fetch(endpoint, { headers: auth })
  assert.equal(get.status, 405)
  assert.deepEqual(await get.json(), { error: "只接受 POST" })

  const badJson = await fetch(endpoint, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: "{not json",
  })
  assert.equal(badJson.status, 400)
  assert.deepEqual(await badJson.json(), { error: "请求体不是合法 JSON" })

  // ⚠️ 非回环地址是这里的核心断言：重放若允许外网 URL，服务器就变成一个
  //    「带管理凭据的请求发起器」，比开放代理更危险。
  for (const url of ["http://example.com/cb?code=1", "http://192.168.1.10:8080/cb", "file:///etc/passwd"]) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ url }),
    })
    assert.equal(response.status, 400, `${url} 应被拒绝`)
    assert.match((await response.json()).error, /只接受本机回调地址/)
  }

  // 合法地址但端口没人监听 ⇒ 502（证明前面的校验确实放行了回环地址）。
  const unreachable = await fetch(endpoint, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ url: "http://127.0.0.1:41451/never-listening" }),
  })
  assert.equal(unreachable.status, 502)
  const payload = await unreachable.json()
  assert.equal(payload.ok, false)
  assert.equal(payload.port, 41451)
  assert.match(payload.error, /已不可达/)
})

test("中继 UI 脚本可匿名取到（它只是前端壳，不含数据）", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // ⚠️ 这个脚本挂在 /admin 前缀下但由 oauthRelay.handle 提供，仍在鉴权门之后，
  //    所以未登录应当 401/302 —— 与 relay 同一策略，不能因为「只是 JS」就放开。
  const anonymous = await fetch(`${app.origin}/admin/oauth-relay-ui.js`, { redirect: "manual" })
  assert.equal(anonymous.status, 401)

  const authorized = await fetch(`${app.origin}/admin/oauth-relay-ui.js`, {
    headers: { authorization: `Bearer ${app.adminKey}` },
  })
  assert.equal(authorized.status, 200)
  assert.match(authorized.headers.get("content-type") ?? "", /application\/javascript/)
  assert.equal(authorized.headers.get("cache-control"), "no-store")
  const source = await authorized.text()
  // 面板挂件的两个入口都在这个脚本里；出现其中一个就说明取到的是真身。
  assert.match(source, /__c2OAuthRelayLoaded/)
})
