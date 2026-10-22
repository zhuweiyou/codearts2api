/**
 * `/admin` 管理界面的**薄入口**。
 *
 * ## 核心思路：直接复用上游打包好的 `JetHubPage`
 *
 * 上游插件的浏览器端产物（`dsh-providers-hub/client` → `lib/client/jet-hub.js`）
 * 是 esbuild 全量打包的 CJS，**只 external 了 `react` 与 `react-dom`**，并且
 * 以 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 形态发布：
 *
 * ```js
 * window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })
 * ```
 *
 * 它的 `apply(ctx)` 会把整页 UI 组件注册进 `ctx.slots` 的 `settings.section`
 * 槽。于是复用只需三步，**不用重新实现任何界面**：
 *
 * 1. 页面里先定义 `window.__ModuleLoader__.load`，把那一行 `{id, factory}` 截下来；
 * 2. 调 `factory(require)` 拿到模块（`require` 只喂 react / react-dom）；
 * 3. 用一个**桩 ctx** 调它的 `apply()`，从 `slots.register` 里把
 *    `settings.section` 的组件捞出来，再用真实的 `rpcCall` 渲染。
 *
 * 第 3 步的桩 ctx 提供 `effect` / `slots` / `connection` / `inject` /
 * `modelDirectories` —— 这是上游客户端的全部宿主依赖面（`modelDirectories`
 * 只被 `conversation.input.right` 的用量徽标用到，本页不渲染那个槽，故给个
 * 调用即抛的替身即可，避免将来上游改用它时静默拿到 undefined）。
 *
 * ⚠️ `ctx.inject` 是**必填**：上游 `registerJetHubSidebarEntry` 里会调
 * `ctx.inject(["layout"], …)` 挂侧栏入口。缺了它，`apply` 直接抛
 * `ctx.inject is not a function`，整页白屏（2026-10-22 升级到 dsh-providers-hub
 * 时踩过）。本页只渲染 `settings.section`，侧栏那套与本页无关，故实现为
 * 「立即用空 services 回调一次」，让上游那段代码正常走完即可。
 *
 * ## 为什么 UI 更新不需要改这里的代码
 *
 * 界面随上游 bundle 走：升级依赖 commit 后重新 `npm run build` 即可拿到新版
 * 界面。这里的代码只处理「装载 + 接线」，不含任何布局 —— 所以上游改布局
 * 不会被本仓库的拷贝拖住（这是选择复用而非自研的主要理由）。
 */

import * as React from "react"
import { createRoot } from "react-dom/client"
import { createPortal } from "react-dom"

/** 上游 bundle 通过 `__ModuleLoader__` 交出的一行。 */
const captured = globalThis.__JET_HUB_ROW__

/**
 * 上游的 `callManagementRpc(connection, channel, method, payload, signal)` 语义：
 * 以 `{ method, payload }` 的信封 POST 到 `/api/jet-hub`，响应是
 * `{ type:'server-response', rpcId, result }`，其中
 * `result = { ok:true, value }` 或 `{ ok:false, error }`。
 *
 * 这里直接按该协议发请求（等价于上游客户端经 `connection.rpc.call` 走的那条路，
 * 只是省掉 DSH 的中转层）。**必须**与上游 `unwrapRpcResult` 同语义：`ok` 为假
 * 时抛带 `code` 的 Error，因为界面按 `error.code` 与 message 做提示。
 */
async function rpcCall(method, payload, signal) {
  const response = await fetch("/api/jet-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
      method: "jet-hub",
      payload: { method, payload },
    }),
    signal,
  })
  if (!response.ok) throw new Error(`管理接口返回 HTTP ${response.status}`)
  const body = await response.json()
  const result = body?.result
  if (result?.ok === true) return result.value
  if (result?.ok === false) {
    const error = new Error(result.error?.message ?? "Jet Hub 请求失败")
    error.code = result.error?.code
    throw error
  }
  throw new Error("管理接口返回了无法识别的响应")
}

/**
 * 从上游 bundle 的行里取出 `JetHubPage` 组件。
 *
 * @returns 组件；任何一步失败都抛出可读错误（而不是白屏）。
 */
function loadUpstreamPage() {
  if (captured === null || typeof captured !== "object" || typeof captured.factory !== "function") {
    throw new Error("上游 jet-hub 客户端 bundle 未先加载（upstream-jet-hub.js 缺失或加载失败）")
  }

  const upstream = captured.factory((name) => {
    if (name === "react") return React
    if (name === "react-dom") return { createPortal }
    throw new Error(`上游 bundle 请求了未预期的模块：${name}`)
  })

  let page = null
  // 桩 ctx：上游客户端的宿主依赖面（effect / slots / connection / inject /
  // modelDirectories）。缺任何一个，上游 `apply` 都可能直接抛。
  upstream.apply({
    // `apply` 里用 effect 装了全局样式。真 DSH 会传入 disposer 语义的清理器，
    // 这里直接执行：本页面只加载一次，不需要撤销。
    effect: (body) => body(),
    // ⚠️ **必填**：上游 `registerJetHubSidebarEntry` 会调
    //    `ctx.inject(["layout"], (scoped) => …)` 挂侧栏入口。
    //    本页只渲染 `settings.section`，侧栏与本页无关 —— 直接以空 services
    //    回调一次，让上游那段代码走完、不抛即可（它只读 `scoped.layout`，
    //    拿到 undefined 后所有逻辑都被 `?.` 短路掉）。
    inject: (_deps, callback) => {
      callback({})
      return () => {}
    },
    // 同上：`conversation.input.right` 的用量徽标会读它。本页不渲染那个槽，
    // 但上游 `apply` 期可能触碰，故给显式失败的替身而非 undefined。
    modelDirectories: {
      directoryFor() {
        throw new Error("本宿主不提供 ctx.modelDirectories（/admin 不渲染会话槽位）")
      },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        if (options?.name === "settings.section") page = component
        return () => {}
      },
    },
    // 上游 apply 只做注册，不会在此时发请求；给一个显式失败的替身，
    // 万一将来上游在 apply 期调用它，能立刻暴露而不是静默拿到 undefined。
    connection: {
      rpc: {
        async call() {
          throw new Error("本宿主不提供 connection.rpc.call，请经 rpcCall 直连 /api/jet-hub")
        },
      },
    },
  })

  if (page === null) throw new Error("上游未注册 settings.section，无法渲染管理界面")
  return page
}

const root = document.getElementById("admin-root")
try {
  const Page = loadUpstreamPage()
  // `close` 传 undefined：上游页头会据此**不渲染**「关闭」按钮
  // （`close ? <button…> : null`），这正合独立页面的形态。
  createRoot(root).render(React.createElement(Page, { rpcCall }))
} catch (error) {
  root.innerHTML = `<pre style="padding:24px;font:13px/1.6 ui-monospace,monospace;color:#b42318;white-space:pre-wrap">管理界面加载失败：${String(error?.message ?? error)}</pre>`
}
