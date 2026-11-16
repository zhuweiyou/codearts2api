/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "vite-plus/test"

import { installOAuthRelay } from "../web/utils/oauth-relay.ts"

const realOpen = window.open
const O = () => window.location.origin
const flush = () => new Promise((r) => setTimeout(r, 0))

function reset() {
  document.body.innerHTML = ""
  delete (window as any).__c2aOAuthRelayLoaded
  delete (window as any).__c2aRelayOf
  ;(window as any).open = realOpen
}

beforeEach(reset)
afterEach(reset)

test("window.open：loopback → /relay 改写", () => {
  const calls: any[][] = []
  ;(window as any).open = (...args: any[]) => {
    calls.push(args)
    return null
  }
  installOAuthRelay()
  ;(window as any).open("http://127.0.0.1:19283/auth", "_blank", "w=1")
  assert.equal(calls[0][0], O() + "/relay/19283/auth")
})

test("anchor href 与 .dim-jh-loginLink 文本都改写（回归锁定）", () => {
  ;(window as any).open = realOpen
  const a = document.createElement("a")
  a.className = "dim-jh-loginLink"
  a.setAttribute("href", "http://127.0.0.1:19283/auth")
  a.textContent = "http://127.0.0.1:19283/auth"
  document.body.appendChild(a)
  installOAuthRelay()
  assert.equal(a.getAttribute("href"), O() + "/relay/19283/auth")
  assert.equal(a.textContent, O() + "/relay/19283/auth")
})

test("新增节点（addedNode 自身）href 被改写", async () => {
  ;(window as any).open = realOpen
  installOAuthRelay()
  const a = document.createElement("a")
  a.setAttribute("href", "http://127.0.0.1:19283/y")
  document.body.appendChild(a)
  await flush()
  assert.equal(a.getAttribute("href"), O() + "/relay/19283/y")
})

test("characterData 原地更新文本被改写", async () => {
  ;(window as any).open = realOpen
  const code = document.createElement("code")
  code.textContent = "foo"
  document.body.appendChild(code)
  installOAuthRelay()
  code.firstChild!.nodeValue = "http://127.0.0.1:19283/z"
  await flush()
  assert.equal(code.textContent, O() + "/relay/19283/z")
})

test("端口越界（80）不改写", () => {
  ;(window as any).open = realOpen
  const a = document.createElement("a")
  a.setAttribute("href", "http://127.0.0.1:80/x")
  document.body.appendChild(a)
  installOAuthRelay()
  assert.equal(a.getAttribute("href"), "http://127.0.0.1:80/x")
})

test("幂等安装（重复调用不重复包装 window.open）", () => {
  ;(window as any).open = realOpen
  installOAuthRelay()
  const first = (window as any).open
  installOAuthRelay()
  assert.equal((window as any).open, first)
  assert.equal((window as any).__c2aOAuthRelayLoaded, true)
})
