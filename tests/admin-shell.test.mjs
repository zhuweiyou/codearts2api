import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { JSDOM } from "jsdom"

import { UI_SRC as CALLERS_UI } from "../src/callers-ui.js"
import { UI_SRC as DASHBOARD_UI } from "../src/dashboard-admin.js"
import { UI_SRC as RELAY_UI } from "../src/oauth-relay.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const SHELL_SRC = readFileSync(join(root, "public", "admin-shell.js"), "utf8")
const ADMIN_HTML = readFileSync(join(root, "public", "admin.html"), "utf8")

const openWindows = []
test.afterEach(() => {
  while (openWindows.length) openWindows.pop().close()
})

function bodyMarkup() {
  const body = ADMIN_HTML.slice(ADMIN_HTML.indexOf("<body>") + 6, ADMIN_HTML.indexOf("</body>"))
  return body.replace(/<script[\s\S]*?<\/script>/g, "")
}

async function makePage(options = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${bodyMarkup()}</body></html>`, {
    url: "http://localhost:8080/admin" + (options.hash ?? ""),
    runScripts: "outside-only",
    pretendToBeVisual: true,
  })
  const { window } = dom
  openWindows.push(window)
  window.fetch =
    options.fetch ??
    (async () => ({ ok: true, status: 200, json: async () => ({ adminAuth: true, proxyGateway: true }) }))
  window.console.error = () => {}
  if (options.before) options.before(window)
  window.eval(SHELL_SRC)
  if (window.document.readyState === "loading") {
    await new Promise((resolve) => window.document.addEventListener("DOMContentLoaded", resolve))
  }
  return window
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await tick(5)
  }
  return true
}

test("外壳：默认进入「总览」，导航三项且 aria 状态正确", async () => {
  const window = await makePage()
  const { document } = window
  const tabs = [...document.querySelectorAll("[data-nav]")].map((t) => t.getAttribute("data-nav"))
  assert.deepEqual(tabs, ["overview", "channels", "callers"])
  assert.equal(window.__c2Shell.current(), "overview")
  assert.equal(document.querySelector('[data-nav="overview"]').getAttribute("aria-selected"), "true")
  assert.equal(document.querySelector('[data-view="overview"]').hidden, false)
  assert.equal(document.getElementById("admin-root").hidden, true)
  assert.equal(document.documentElement.getAttribute("data-c2-view"), "overview")
  assert.match(document.documentElement.style.getPropertyValue("--c2-gutter"), /^\d+px$/)
  const inner = document.querySelector(".c2-topbar > .c2-topbarInner")
  assert.ok(
    inner && inner.querySelector(".c2-brand") && inner.querySelector("#c2-nav") && inner.querySelector("#c2-actions"),
  )
})

test("外壳：hash 决定初始视图，未知 hash 回落到总览", async () => {
  assert.equal((await makePage({ hash: "#channels" })).__c2Shell.current(), "channels")
  assert.equal((await makePage({ hash: "#nope" })).__c2Shell.current(), "overview")
})

test("外壳：视图只在第一次显示时 mount，之后每次切换调 onShow / onHide", async () => {
  const window = await makePage({ hash: "#channels" })
  const calls = []
  window.__c2Shell.registerView("callers", {
    mount: (el) => calls.push("mount:" + el.getAttribute("data-view")),
    onShow: () => calls.push("show"),
    onHide: () => calls.push("hide"),
  })
  window.__c2Shell.go("callers")
  await until(() => calls.length === 2)
  window.__c2Shell.go("channels")
  await until(() => calls.length === 3)
  window.__c2Shell.go("callers")
  await until(() => calls.length === 4)
  assert.deepEqual(calls, ["mount:callers", "show", "hide", "show"])
})

test("外壳：主题选择写进 <html data-theme> 并持久化；「跟随系统」清掉属性", async () => {
  const window = await makePage()
  const { document } = window
  document.getElementById("c2-theme").click()
  const dark = [...document.querySelectorAll(".c2-menuItem")].find((b) => b.textContent.includes("深色"))
  dark.click()
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark")
  assert.equal(window.localStorage.getItem("c2-theme"), "dark")

  const again = await makePage({ before: (w) => w.localStorage.setItem("c2-theme", "dark") })
  assert.equal(again.document.documentElement.getAttribute("data-theme"), "dark")

  document.getElementById("c2-theme").click()
  ;[...document.querySelectorAll(".c2-menuItem")].find((b) => b.textContent.includes("跟随系统")).click()
  assert.equal(document.documentElement.hasAttribute("data-theme"), false)
  assert.equal(window.localStorage.getItem("c2-theme"), null)
})

test("外壳：统一弹窗 Esc 关闭，并把焦点还给打开它的按钮", async () => {
  const window = await makePage()
  const { document } = window
  const opener = document.getElementById("c2-theme")
  opener.focus()
  let closed = 0
  window.__c2Shell.openModal({ title: "测试", body: "内容", onClose: () => closed++ })
  assert.ok(document.querySelector(".c2-overlay"))
  assert.equal(document.querySelector(".c2-modal").getAttribute("role"), "dialog")
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  assert.equal(document.querySelector(".c2-overlay"), null)
  assert.equal(closed, 1)
  assert.equal(document.activeElement, opener)
})

test("外壳：关闭鉴权时（本机调试）隐藏「退出」", async () => {
  const window = await makePage({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ adminAuth: false }) }),
  })
  await until(() => window.document.getElementById("c2-logout").hidden)
  assert.equal(window.document.getElementById("c2-logout").hidden, true)
})

test("总览 / 调用方 / 回调修复都不再往上游页头插按钮", async () => {
  const window = await makePage()
  const { document } = window
  const header = document.createElement("div")
  header.className = "dim-jh-headerActions"
  document.getElementById("admin-root").appendChild(header)
  window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
  window.eval(DASHBOARD_UI)
  window.eval(CALLERS_UI)
  window.eval(RELAY_UI)
  await until(() => document.querySelector('[data-view="overview"] .c2-page'))
  await tick(30)
  assert.equal(header.children.length, 0, "上游页头里不应出现本项目的按钮")
  assert.equal(document.querySelector(".c2or-fab"), null, "不应再有右下角悬浮按钮")
  assert.ok(document.querySelector('[data-action="oauth-relay"]'), "回调修复应在外壳顶栏")
  assert.ok(document.querySelector('[data-view="overview"] .c2-page'), "总览应渲染为页面")
})

async function openRelay(replay) {
  const window = await makePage()
  window.eval(RELAY_UI)
  window.fetch = replay
  window.document.querySelector('[data-action="oauth-relay"]').click()
  const { document } = window
  const ta = document.getElementById("c2or-url")
  const run = [...document.querySelectorAll(".c2-modalFoot button")].find((b) => b.textContent === "重放")
  const type = (value) => {
    ta.value = value
    ta.dispatchEvent(new window.Event("input", { bubbles: true }))
  }
  return { window, document, ta, run, type }
}

test("回调修复：打开即聚焦输入框，空输入时「重放」不可点", async () => {
  const { document, ta, run } = await openRelay()
  assert.equal(document.activeElement, ta)
  assert.equal(run.disabled, true)
})

test("回调修复：非本机地址 / 端口越界当场提示，按钮保持不可点", async () => {
  const { ta, run, type, document } = await openRelay()
  type("https://example.com/callback?code=abc")
  assert.equal(run.disabled, true)
  assert.equal(ta.getAttribute("aria-invalid"), "true")
  assert.match(document.querySelector(".c2-hint").textContent, /不是本机回调地址/)

  type("http://127.0.0.1:80/callback")
  assert.equal(run.disabled, true)
  assert.match(document.querySelector(".c2-hint").textContent, /超出允许范围/)
})

test("回调修复：合法地址显示识别结果，按钮可点", async () => {
  const { ta, run, type, document } = await openRelay()
  type("http://127.0.0.1:41451/auth/callback?code=abc&state=xyz")
  assert.equal(run.disabled, false)
  assert.equal(ta.hasAttribute("aria-invalid"), false)
  const hint = document.querySelector(".c2-hint").textContent
  assert.match(hint, /端口 41451/)
  assert.match(hint, /\/auth\/callback/)
  assert.match(hint, /带授权码/)
})

test("回调修复：成功后清空授权码并给出下一步", async () => {
  const { ta, run, type, document } = await openRelay(async () => ({
    status: 200,
    json: async () => ({ ok: true, status: 200, port: 41451, snippet: "登录成功" }),
  }))
  type("http://127.0.0.1:41451/auth/callback?code=secret")
  run.click()
  await until(() => document.querySelector('.c2-callout[data-tone="ok"]'))
  const out = document.querySelector('.c2-callout[data-tone="ok"]')
  assert.ok(out, "应显示成功提示")
  assert.match(out.textContent, /渠道管理/)
  assert.equal(ta.value, "", "授权码用过即清空")
})

test("回调修复：上游拒绝（授权码失效）与端口已关闭分别给出不同提示", async () => {
  const rejected = await openRelay(async () => ({ status: 200, json: async () => ({ ok: false, status: 400 }) }))
  rejected.type("http://127.0.0.1:41451/cb?code=old")
  rejected.run.click()
  await until(() => rejected.document.querySelector('.c2-callout[data-tone="warn"]'))
  const warn = rejected.document.querySelector('.c2-callout[data-tone="warn"]')
  assert.ok(warn)
  assert.match(warn.textContent, /新建账号/)
  assert.notEqual(rejected.ta.value, "", "失败时保留输入，方便改了再试")

  const closed = await openRelay(async () => ({
    status: 502,
    json: async () => ({ ok: false, error: "本机 41451 端口已不可达" }),
  }))
  closed.type("http://127.0.0.1:41451/cb?code=x")
  closed.run.click()
  await until(() => closed.document.querySelector('.c2-callout[data-tone="err"]'))
  const err = closed.document.querySelector('.c2-callout[data-tone="err"]')
  assert.ok(err)
  assert.match(err.textContent, /登录监听已经关闭/)
  assert.match(err.textContent, /41451/)
})

function snapshot() {
  const pkg = (provider, name) => ({
    provider,
    name,
    unit: "credits",
    total: 100,
    used: 10,
    remaining: 90,
    accountId: provider + "-1",
    nickname: provider + " 账号",
    endAt: null,
  })
  return {
    generatedAt: new Date().toISOString(),
    credits: {
      packages: [pkg("buddy", "包 A"), pkg("buddy", "包 B"), pkg("codearts", "包 C")],
      units: [{ unit: "credits", total: 300, used: 30, remaining: 270, packs: 3 }],
      expiry: { d7: [], d30: [], expired: [] },
    },
  }
}

test("总览：渠道积分明细默认折叠，点开的渠道在自动重画后保持展开", async () => {
  const window = await makePage()
  window.fetch = async () => ({ ok: true, status: 200, json: async () => snapshot() })
  window.eval(DASHBOARD_UI)
  const { document } = window
  const blocks = () => [...document.querySelectorAll("details.c2d-chan")]
  await until(() => blocks().length === 2)
  assert.equal(blocks().length, 2)
  assert.ok(
    blocks().every((d) => !d.open),
    "默认全部折叠",
  )
  assert.match(blocks()[0].querySelector("summary").textContent, /结余/)

  const buddy = blocks().find((d) => d.getAttribute("data-prov") === "buddy")
  buddy.open = true
  buddy.dispatchEvent(new window.Event("toggle"))

  const before = blocks()[0]
  document.getElementById("c2d-refresh").click()
  await until(() => blocks()[0] !== before)
  const after = blocks()
  assert.equal(after.find((d) => d.getAttribute("data-prov") === "buddy").open, true, "buddy 保持展开")
  assert.equal(after.find((d) => d.getAttribute("data-prov") === "codearts").open, false)
})

test("admin.html：外壳脚本在 <head>，三个装载脚本仍在 <body> 末尾", async () => {
  const head = ADMIN_HTML.slice(0, ADMIN_HTML.indexOf("</head>"))
  assert.match(head, /<script src="\/admin-shell\.js"><\/script>/)
  const body = ADMIN_HTML.slice(ADMIN_HTML.indexOf("<body>"))
  for (const src of ["/admin-boot.js", "/upstream-jet-hub.js", "/admin.js"]) {
    assert.ok(body.includes(`src="${src}"`), `${src} 应在 body 里`)
  }
})
