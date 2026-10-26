/**
 * `/admin` 管理界面的**薄入口**。
 *
 * ## 核心思路：直接复用上游打包好的 `JetHubPage`
 *
 * 上游插件的浏览器端产物（`dsh-providers-hub/client` → `lib/client/jet-hub.js`）
 * 是 esbuild 全量打包的 CJS，**只 external 了 `react` / `react-dom`（以及宿主的
 * UI 原子库，见下）**，并且以 DSH 的 `window.__ModuleLoader__.load({ id, factory })`
 * 形态发布：
 *
 * ```js
 * window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })
 * ```
 *
 * 它的 `apply(ctx)` 会把整页 UI 组件注册进 `ctx.slots`（`main` 与
 * `settings.section` 两个槽）。于是复用只需三步，**不用重新实现任何界面**：
 *
 * 1. 页面里先定义 `window.__ModuleLoader__.load`，把那一行 `{id, factory}` 截下来；
 * 2. 调 `factory(require)` 拿到模块（`require` 只喂 react / react-dom / 上游用到的
 *    宿主 UI 原子，见下面「上游还 external 了宿主的 UI 原子库」）；
 * 3. 用一个**桩 ctx** 调它的 `apply()`，从 `slots.register` 里把整页组件捞出来，
 *    再用真实的 `rpcCall` 渲染。
 *
 * 第 3 步的桩 ctx 提供 `effect` / `slots` / `connection` / `inject` /
 * `modelDirectories` —— 这是上游客户端的全部宿主依赖面（`modelDirectories`
 * 只被 `conversation.input.right` 的用量徽标用到，本页不渲染那个槽，故给个
 * 调用即抛的替身即可，避免将来上游改用它时静默拿到 undefined）。
 *
 * ⚠️ `ctx.inject` 是**必填**：上游 `registerJetHubSidebarEntry` 里会调
 * `ctx.inject(["layout"], …)` 挂侧栏入口。缺了它，`apply` 直接抛
 * `ctx.inject is not a function`，整页白屏（2026-10-22 升级到 dsh-providers-hub
 * 时踩过）。本页不渲染侧栏，故实现为「立即用空 services 回调一次」。
 *
 * ⚠️ `ctx.connection.rpc.call` 也必须**真的能调通**（2026-10-26）：上游 `apply`
 * 里会读「面板入口」偏好（`loadPanelEntry`），读不到就退回默认值 —— 而默认值
 * 是「仅侧栏」，于是 `settings.section` **不注册**。早先这里给的是「调用即抛」
 * 的替身，症状就是「上游未注册 settings.section」。详见 `loadUpstreamPage()`。
 *
 * ## 上游还 external 了宿主的 UI 原子库（2026-10-26 换源后发现）
 *
 * 新版上游 bundle 除了 react / react-dom，还 `require` 了
 * `@deepseek-ai/dsh-client-ui-primitives` —— 它只用其中两个导出：
 * `Menu`（插件详情卡片里那个下拉菜单）与 `IconChevronDownOutlineRegular`（下箭头）。
 *
 * ⚠️ **不要**把这个包整个装进来：它的 `lib/index.js` 顶层就 `import` 了 shiki /
 * katex / mdast 一整条 markdown + 高亮链路（连带 `.woff` / `.ttf` 字体），
 * 为了两个组件把 `admin.js` 撑大一个数量级，esbuild 还会直接因为字体 loader 报错。
 * 而且它用的是 **CSS Module**，发布产物里那些 `*_module_css_default` 全是 `{}` ——
 * 样式本来就由 DSH 宿主的样式表提供，我们独立页面里拿到的只会是一排没有类名的元素。
 *
 * 所以按本文件一贯的做法：**在 `require` 分支里给一份等价的最小实现**（见下面的
 * `Menu` / `IconChevronDown`），行为对齐上游那几个 props（open / anchor / items /
 * selectedId / onSelect / onClose / align / side / portal），样式用内联写死。
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
 * 上游 browser bundle 除了 react / react-dom 之外唯一 require 的模块名。
 *
 * 见文件头「上游还 external 了宿主的 UI 原子库」一节：**不装这个包**，
 * 用下面两个最小替身顶上。
 */
const UPSTREAM_UI_PRIMITIVES = "@deepseek-ai/dsh-client-ui-primitives"

/** 上游 `Menu` 里用到的下拉箭头（`IconChevronDownOutlineRegular` 的替身）。 */
function IconChevronDownOutlineRegular({ className, size = 14 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
      style={{ flex: "0 0 auto" }}
    >
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * 上游 `Menu` 的最小替身（下游只用到 `plugin-src/client/settings-card.js` 那个
 * 「面板入口」下拉，props 面就下面这些）。
 *
 * 行为对齐上游：`open` 时渲染列表；点外部或按 Esc 调 `onClose`；点条目调
 * `onSelect(id)`；`selectedId` 打勾；`portal` 时按锚点矩形做 fixed 定位
 * （上游加 `portal` 正是为了躲开滚动容器的 `overflow` 裁剪）。
 *
 * ⚠️ 上游那份用 CSS Module，发布产物里类名对象是空的 —— 样式全靠宿主样式表。
 *    我们独立页面没有宿主样式表，所以这里**内联**给最小可用的外观。
 */
function Menu({
  open,
  anchor,
  items = [],
  selectedId,
  onSelect,
  onClose,
  align = "start",
  side = "bottom",
  portal = false,
  className,
}) {
  const rootRef = React.useRef(null)
  const listRef = React.useRef(null)
  const [position, setPosition] = React.useState(null)

  // 定位：只在 portal 时做（就地渲染由 CSS 的相对定位负责）。
  React.useLayoutEffect(() => {
    if (!open || !portal) {
      setPosition(null)
      return
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const margin = 12
      const width = listRef.current?.offsetWidth ?? 0
      const height = listRef.current?.offsetHeight ?? 0
      const left = align === "end" ? rect.right - width : rect.left
      const top = side === "top" ? rect.top - height - 4 : rect.bottom + 4
      // 夹在视口内（上游同逻辑），否则靠右/靠下的锚点会把菜单推出屏幕。
      setPosition({
        left: Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - width - margin)),
        top: Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - height - margin)),
      })
    }
    place()
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [open, portal, align, side])

  // 关闭语义：点外部 / Esc。
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target)) return
      if (listRef.current?.contains(target)) return
      onClose?.()
    }
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose?.()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, onClose])

  // 先按不可见布局一次，量到宽高后 useLayoutEffect 再摆到位（避免首帧闪到左上角）。
  const listStyle = {
    minWidth: 140,
    padding: 4,
    margin: 0,
    borderRadius: 8,
    border: "1px solid rgba(0,0,0,.12)",
    background: "#fff",
    boxShadow: "0 8px 24px rgba(0,0,0,.16)",
    zIndex: 2147483000,
    ...(portal
      ? { position: "fixed", ...(position ?? { left: 0, top: 0, visibility: "hidden" }) }
      : {
          position: "absolute",
          top: side === "top" ? undefined : "calc(100% + 4px)",
          bottom: side === "top" ? "calc(100% + 4px)" : undefined,
          [align === "end" ? "right" : "left"]: 0,
        }),
  }

  const list = open ? (
    <div ref={listRef} role="menu" className={className} style={listStyle} onClick={(event) => event.stopPropagation()}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return
            onSelect?.(item.id)
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "6px 10px",
            border: 0,
            borderRadius: 6,
            background: item.id === selectedId ? "rgba(0,0,0,.06)" : "transparent",
            color: "inherit",
            font: "inherit",
            textAlign: "left",
            cursor: item.disabled ? "not-allowed" : "pointer",
          }}
        >
          <span style={{ flex: 1 }}>{item.label}</span>
          {item.id === selectedId ? <span aria-hidden="true">✓</span> : null}
        </button>
      ))}
    </div>
  ) : null

  return (
    <span ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      {anchor}
      {portal && list ? createPortal(list, document.body) : list}
    </span>
  )
}

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
    // 宿主 UI 原子库：只给上游真正用到的那两个导出（见文件头）。
    if (name === UPSTREAM_UI_PRIMITIVES) return { Menu, IconChevronDownOutlineRegular }
    throw new Error(`上游 bundle 请求了未预期的模块：${name}`)
  })

  // 上游注册了两个「整页」组件，我们要的是**整页本身**，不是它的外层包装：
  //
  //   · `main`（`JetHubMainPanel`）—— **无条件**注册，包一层 `.dim-jh-panelHost`
  //     （中央面板的顶部留白），里面就是 `JetHubPage`；
  //   · `settings.section`（`JetHubPageForSettings`）—— 2026-10-26 起**条件注册**：
  //     只有「面板入口」偏好是 `settings` 时才注册（默认是 `sidebar`），
  //     所以它**不能**当作唯一来源 —— 否则默认配置下 `page` 永远是 null。
  //
  // 故：两个都收，**优先 `main`**（它必然存在），`settings.section` 作兜底。
  let mainPage = null
  let settingsPage = null
  // 桩 ctx：上游客户端的宿主依赖面（effect / slots / connection / inject /
  // modelDirectories）。缺任何一个，上游 `apply` 都可能直接抛。
  upstream.apply({
    // `apply` 里用 effect 装了全局样式。真 DSH 会传入 disposer 语义的清理器，
    // 这里直接执行：本页面只加载一次，不需要撤销。
    effect: (body) => body(),
    // ⚠️ **必填**：上游 `registerJetHubSidebarEntry` 会调
    //    `ctx.inject(["layout"], (scoped) => …)` 挂侧栏入口。
    //    本页不渲染侧栏 —— 直接以空 services 回调一次，让上游那段代码走完、
    //    不抛即可（它只读 `scoped.layout`，拿到 undefined 后全部被 `?.` 短路）。
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
        if (options?.name === "main") mainPage = component
        if (options?.name === "settings.section") settingsPage = component
        return () => {}
      },
    },
    // ⚠️ **必须真的能调通**（2026-10-26）：上游 `apply` 里会 `void
    //    loadPanelEntry(rpcCall)` 读「面板入口」偏好，`rpcCall` 就是从
    //    `connection.rpc.call` 派生的。早先这里给的是「调用即抛」的替身，
    //    结果偏好读不到、退回默认值，`settings.section` 于是永不注册。
    //    现在按上游的真实签名把请求转给 `rpcCall`：
    //    `connection.rpc.call(channel, endpoint, { method, payload }, signal)`，
    //    channel/endpoint 由上游自己传（`/api` + `jet-hub`），我们只取后两个。
    connection: {
      rpc: {
        async call(_channel, _endpoint, request, signal) {
          return rpcCall(request?.method, request?.payload, signal)
        },
      },
    },
  })

  const page = mainPage ?? settingsPage
  if (page === null) throw new Error("上游未注册 main / settings.section，无法渲染管理界面")
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
