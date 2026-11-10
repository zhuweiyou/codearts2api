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

function recRow(over = {}) {
  return {
    ts: new Date().toISOString(),
    caller: "k_a",
    name: "DSH 桌面",
    model: "aggregate/doubao-2-0-mini",
    status: 200,
    stream: false,
    ms: 2400,
    in_tokens: 1398,
    out_tokens: 511,
    ...over,
  }
}

async function openRecords(db, options = {}) {
  const calls = { records: 0 }
  const window = await makePage({
    hash: "#callers",
    before(w) {
      w.__c2RecAutoMs = 40
      if (options.paused) w.localStorage.setItem("c2-rec-auto", "0")
    },
  })
  window.fetch = async (url, init) => {
    if (String(url) !== "/admin/callers/api") {
      return { ok: true, status: 200, json: async () => ({ adminAuth: true }) }
    }
    const body = JSON.parse(init.body)
    if (body.action === "records") {
      calls.records += 1
      const rows = db.rows.slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
      const byModel = {}
      for (const x of rows) {
        const m = (byModel[x.model] ??= {
          model: x.model,
          calls: 0,
          errors: 0,
          inTokens: 0,
          outTokens: 0,
          byCaller: {},
        })
        m.calls += 1
        if (x.status >= 400) m.errors += 1
        m.byCaller[x.caller] = (m.byCaller[x.caller] ?? 0) + 1
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          days: ["2026-11-10"],
          total: rows.length,
          shown: rows.length,
          rows,
          byModel: Object.values(byModel),
          availableDays: ["2026-11-10"],
        }),
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        groups: [],
        keys: [{ id: "k_a", name: "DSH 桌面", group: "full", enabled: true }],
        usage: { day: "2026-11-10", rows: [] },
        storePath: "",
      }),
    }
  }
  window.eval(CALLERS_UI)
  window.__c2Shell.go("callers")
  const { document } = window
  await until(() => document.querySelector('[data-tab="records"]'))
  document.querySelector('[data-tab="records"]').click()
  await until(() => document.querySelector('[data-rec-pane="detail"] tbody'))
  return { window, document, calls }
}

test("调用记录：逐条明细按天分组，显示调用方名字、失败原因、输入 / 输出与方式", async () => {
  const db = {
    rows: [
      recRow({ ts: new Date(Date.now() - 3000).toISOString() }),
      recRow({ ts: new Date(Date.now() - 2000).toISOString(), status: 502, out_tokens: 0, ms: 30000 }),
      recRow({ ts: new Date(Date.now() - 1000).toISOString(), stream: true, model: "qoder/claude-sonnet" }),
    ],
  }
  const { document } = await openRecords(db)
  const pane = document.querySelector('[data-rec-pane="detail"]')
  const heads = [...pane.querySelectorAll("th")].map((th) => th.textContent)
  assert.deepEqual(heads, ["时间", "调用方", "模型", "结果", "耗时", "输入", "输出", "方式"])
  assert.match(pane.querySelector(".c2m-recday").textContent, /^今天 · /)
  const rows = [...pane.querySelectorAll("tr.c2m-recrow")]
  assert.equal(rows.length, 3)
  assert.equal(rows[0].querySelector(".c2m-recway").textContent, "流式")
  assert.equal(rows[2].querySelector(".c2m-recway").textContent, "一次性")
  assert.equal(rows[2].querySelector(".c2m-recwho").textContent, "DSH 桌面")
  assert.equal(rows[2].querySelector(".c2m-recsub").textContent, "k_a")
  assert.equal(rows[2].querySelector(".c2m-recname").textContent, "doubao-2-0-mini")
  assert.equal(rows[2].querySelector(".c2m-recprov").textContent, "aggregate")
  assert.equal(rows[2].querySelector(".c-in").textContent, "1,398")
  assert.equal(rows[2].querySelector(".c-ms .c2m-recms").firstChild.textContent, "2.4 s")
  assert.ok(rows[1].classList.contains("bad"))
  assert.match(rows[1].querySelector(".c-res").textContent, /502.*上游出错/)
  assert.equal(rows[1].querySelector(".c-out").textContent, "—")
  assert.match(document.querySelector('[data-rec-title="detail"]').textContent, /失败 1/)
  const chip = document.querySelector('[data-rec-pane="model"] .c2m-mwho')
  assert.equal(chip.firstChild.textContent, "DSH 桌面", "谁在调应显示 Key 的名字而不是 id")
  assert.equal(chip.title, "DSH 桌面 · k_a", "名字可能被截断，悬停应能看到完整名字与 id")
})

test("调用记录：自动刷新只插入新行，已有行保持原 DOM 节点；没有新数据时不动 DOM", async () => {
  const db = { rows: [recRow({ ts: new Date(Date.now() - 5000).toISOString() })] }
  const { document, calls } = await openRecords(db)
  const pane = document.querySelector('[data-rec-pane="detail"]')
  const oldRow = pane.querySelector("tr.c2m-recrow")
  const modelRow = () =>
    [...document.querySelectorAll('[data-rec-pane="model"] tbody tr')].find(
      (tr) => tr.getAttribute("data-k") === "m:aggregate/doubao-2-0-mini",
    )
  const oldModelRow = modelRow()
  assert.ok(oldModelRow)

  const quiet = calls.records
  assert.ok(await until(() => calls.records >= quiet + 2), "应按间隔自动请求")
  assert.equal(pane.querySelector("tr.c2m-recrow"), oldRow, "没有新数据时不应重建行")
  assert.equal(pane.querySelectorAll(".c2m-recnew").length, 0)
  assert.equal(modelRow(), oldModelRow, "没有新数据时汇总行也不应重建")

  db.rows.push(recRow({ ts: new Date().toISOString(), model: "qoder/claude-sonnet", stream: true }))
  assert.ok(await until(() => pane.querySelectorAll("tr.c2m-recrow").length === 2), "新记录应自动出现")
  const rows = [...pane.querySelectorAll("tr.c2m-recrow")]
  assert.ok(rows[0].classList.contains("fresh"), "新记录应高亮")
  assert.equal(rows[0].querySelector(".c2m-recnew").textContent, "新")
  assert.equal(rows[1], oldRow, "原有的行应原样保留（同一个 DOM 节点）")
  assert.equal(modelRow(), oldModelRow, "汇总里数字没变的行应保留原 DOM 节点")
  assert.equal(document.querySelectorAll('[data-rec-pane="model"] tbody tr').length, 2)
  assert.match(document.querySelector('[data-rec-title="detail"]').textContent, /共 2 条/)
})

test("调用记录：改了筛选未查询、手动暂停、切走页面时都停止自动刷新", async () => {
  const db = { rows: [recRow()] }
  const { window, document, calls } = await openRecords(db)
  const text = () => document.querySelector("[data-rec-autotext]").textContent

  const select = document.querySelector('[data-role="status"]')
  select.value = "error"
  select.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.match(text(), /筛选已改动/)
  let n = calls.records
  await tick(200)
  assert.equal(calls.records, n, "筛选改动后、点「查询」前不应自动刷新")

  select.value = ""
  select.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.ok(await until(() => calls.records > n), "改回原筛选后应恢复刷新")

  document.querySelector('[data-act="rec-auto"]').click()
  assert.match(text(), /已暂停/)
  assert.equal(window.localStorage.getItem("c2-rec-auto"), "0")
  n = calls.records
  await tick(200)
  assert.equal(calls.records, n, "暂停后不应再请求")

  document.querySelector('[data-act="rec-auto"]').click()
  assert.ok(await until(() => calls.records > n), "继续后应立即恢复刷新")
  assert.equal(window.localStorage.getItem("c2-rec-auto"), null)

  window.__c2Shell.go("overview")
  await tick(20)
  n = calls.records
  await tick(200)
  assert.equal(calls.records, n, "切到其它页面后不应再请求")
})

test("调用记录：暂停状态记在浏览器里，下次打开保持暂停", async () => {
  const { document, calls } = await openRecords({ rows: [recRow()] }, { paused: true })
  assert.match(document.querySelector("[data-rec-autotext]").textContent, /已暂停/)
  assert.equal(document.querySelector('[data-act="rec-auto"]').textContent, "继续")
  const n = calls.records
  await tick(200)
  assert.equal(calls.records, n)
})
