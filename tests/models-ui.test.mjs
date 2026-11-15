/**
 * 渠道管理右侧「可用模型」面板：搜索框与页签筛选。
 *
 * 回归的 bug（2026-11-16）：`filterOf(provider)` 拿 provider **对象**当键，
 * `view[对象]` 被隐式转成 `"[object Object]"` ⇒ 输入事件写进 `view[id].q`、
 * 渲染时读 `view["[object Object]"].q`，两边不是同一个格子，敲什么都筛全量
 * （页签筛选同因失效）。本文件锁住三件事：
 *
 *   1. 输入筛选词后只剩匹配的行，且输入框不丢焦点 / 输入值不被清空；
 *   2. 页签筛选与搜索词叠加生效；
 *   3. 不同供应商各记各的筛选词，切换时不串味。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { JSDOM } from "jsdom"

import { UI_SRC } from "../src/models-admin.js"

const openWindows = []
test.afterEach(() => {
  while (openWindows.length) openWindows.pop().close()
})

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await tick(5)
  }
  return true
}

/** 两个供应商各自的模型目录：codearts 4 个（1 个已下架），qodercn 2 个。 */
const CATALOG = {
  codearts: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o mini" },
    { id: "deepseek-v3", name: "DeepSeek V3" },
    { id: "glm-4-air", name: "GLM-4 Air", dead: true },
  ],
  qodercn: [
    { id: "claude-sonnet", name: "Claude Sonnet" },
    { id: "qwen-max", name: "Qwen Max" },
  ],
}

function overview(provider) {
  const list = CATALOG[provider] ?? []
  const models = list.map((m) => ({
    id: m.id,
    name: m.name,
    disabled: false,
    dead: m.dead === true,
    state: m.dead === true ? "dead" : "ok",
    limitedAccounts: 0,
    usableAccounts: 1,
    enabledAccounts: 1,
    nextResetAt: null,
  }))
  const counts = { total: models.length, ok: 0, partial: 0, limited: 0, off: 0, dead: 0, usable: 0 }
  for (const m of models) {
    counts[m.state] += 1
    if (m.state === "ok" || m.state === "partial") counts.usable += 1
  }
  return { provider, now: Date.now(), models, counts, accounts: [], accountsError: null }
}

/**
 * 造一个最小可用的上游页面：两个供应商行 + 右侧面板容器。
 * 上游用 `aria-selected` 表示选中，本模块靠读这个属性判断当前供应商。
 */
async function makePage(selected = "codearts") {
  const row = (id, label, on) =>
    `<div class="dim-jh-providerRow" data-provider="${id}">` +
    `<button class="dim-jh-provider" aria-selected="${on}">` +
    `<span class="dim-jh-providerLabel"><strong>${label}</strong></span></button></div>`

  const dom = new JSDOM(
    `<!doctype html><html><body>` +
      row("codearts", "CodeArts", selected === "codearts") +
      row("qodercn", "QoderCN", selected === "qodercn") +
      `<main class="dim-jh-panel"><div class="dim-jh-accountSection">账号管理</div></main>` +
      `</body></html>`,
    { url: "http://localhost:8080/admin", runScripts: "outside-only", pretendToBeVisual: true },
  )
  const { window } = dom
  openWindows.push(window)
  window.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const data = body.action === "overview" ? overview(body.provider) : { ok: true }
    return { ok: true, status: 200, json: async () => data }
  }
  window.eval(UI_SRC)
  const { document } = window
  await until(() => document.querySelector("[data-c2x-q]") !== null)
  return window
}

/** 当前面板里显示出来的模型 id（按行序）。 */
function shownModels(document) {
  return [...document.querySelectorAll(".c2x-mrow")].map((el) => el.getAttribute("data-model"))
}

/**
 * 切换供应商。
 *
 * 上游是 React 应用：点左栏后它会重渲染右侧面板，本模块靠 MutationObserver
 * 观察这次 childList 变化再重挂自己（`aria-selected` 是 attribute 变化，
 * 观察器**不**监听 attribute）。所以这里除了改 `aria-selected`，还要造一次
 * 真实的 childList 变更来模拟上游重渲染 —— 否则面板不会跟着切。
 */
async function switchProvider(document, id) {
  for (const btn of document.querySelectorAll(".dim-jh-providerRow[data-provider] button")) {
    const row = btn.closest("[data-provider]")
    btn.setAttribute("aria-selected", row.getAttribute("data-provider") === id ? "true" : "false")
  }
  const main = document.querySelector("main.dim-jh-panel")
  const probe = document.createElement("div")
  main.appendChild(probe)
  probe.remove()
  await tick(10)
}

/** 模拟逐字输入：每次都重新取节点，顺带能发现「输入框被重建」的回归。 */
async function typeInto(window, text) {
  const { document } = window
  let typed = ""
  for (const ch of text) {
    const input = document.querySelector("[data-c2x-q]")
    input.focus()
    typed += ch
    input.value = typed
    input.dispatchEvent(new window.Event("input", { bubbles: true }))
    await tick(20)
  }
  return typed
}

test("模型清单：输入筛选词只剩匹配行，且输入框不丢焦点、不清空", async () => {
  const window = await makePage()
  const { document } = window
  assert.deepEqual(shownModels(document), ["gpt-4o", "gpt-4o-mini", "deepseek-v3", "glm-4-air"], "默认应是全量")

  await typeInto(window, "deep")

  assert.deepEqual(shownModels(document), ["deepseek-v3"], "输入 deep 应只剩 deepseek-v3")
  const input = document.querySelector("[data-c2x-q]")
  assert.equal(input.value, "deep", "输入值不能被重建冲掉")
  assert.equal(document.activeElement, input, "输入过程中焦点不能被重建抢走")

  // 命中 id 片段 + 大小写不敏感
  const upper = document.querySelector("[data-c2x-q]")
  upper.value = "MINI"
  upper.dispatchEvent(new window.Event("input", { bubbles: true }))
  await until(() => shownModels(document).length === 1)
  assert.deepEqual(shownModels(document), ["gpt-4o-mini"], "MINI 应命中 gpt-4o-mini（大小写不敏感）")

  // 清空恢复全量
  const empty = document.querySelector("[data-c2x-q]")
  empty.value = ""
  empty.dispatchEvent(new window.Event("input", { bubbles: true }))
  await until(() => shownModels(document).length === 4)
  assert.equal(shownModels(document).length, 4, "清空搜索词应恢复全量")
})

test("模型清单：页签筛选生效，并与搜索词叠加", async () => {
  const window = await makePage()
  const { document } = window

  // 已下架 = 1 个（glm-4-air）
  document.querySelector('[data-c2x-filter="off"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  await until(() => shownModels(document).length === 1)
  assert.deepEqual(shownModels(document), ["glm-4-air"], "「已关闭」页签应只剩已下架的模型")
  assert.equal(
    document.querySelector('[data-c2x-filter="off"]').getAttribute("aria-pressed"),
    "true",
    "页签选中态要跟着更新",
  )

  // 可用 = 3 个
  document.querySelector('[data-c2x-filter="usable"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  await until(() => shownModels(document).length === 3)
  assert.deepEqual(shownModels(document), ["gpt-4o", "gpt-4o-mini", "deepseek-v3"])

  // 在「可用」页签上再搜 deep → 交集
  await typeInto(window, "deep")
  assert.deepEqual(shownModels(document), ["deepseek-v3"], "页签 + 搜索词应取交集")

  // 搜索词与「已关闭」页签无交集 → 空态
  document.querySelector('[data-c2x-filter="off"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  await until(() => document.querySelector(".c2x-empty") !== null)
  assert.equal(document.querySelector(".c2x-empty").textContent, "没有匹配的模型")
  assert.equal(
    document.querySelector("[data-c2x-q]").value,
    "deep",
    "切页签重建后搜索词仍要留在输入框里（视图状态存在 JS 里，不靠 DOM）",
  )
})

test("模型清单：切换供应商时各自的筛选词互不串味", async () => {
  const window = await makePage()
  const { document } = window

  await typeInto(window, "deep")
  assert.deepEqual(shownModels(document), ["deepseek-v3"])

  // 切到 qodercn：它自己没有筛选词，应显示全量
  await switchProvider(document, "qodercn")
  const fresh = await until(() => shownModels(document).includes("qwen-max"))
  assert.ok(fresh, "切到 qodercn 后应拉到并渲染它自己的模型")
  assert.equal(document.querySelector("[data-c2x-q]").value, "", "换供应商后不该继承上一个的搜索词")
  assert.deepEqual(shownModels(document), ["claude-sonnet", "qwen-max"])

  // 切回 codearts：原来的 deep 还在
  await switchProvider(document, "codearts")
  const back = await until(() => document.querySelector("[data-c2x-q]").value === "deep")
  assert.ok(back, "切回原供应商应恢复它自己的搜索词")
  assert.equal(document.querySelector("[data-c2x-q]").value, "deep")
  assert.deepEqual(shownModels(document), ["deepseek-v3"])
})
