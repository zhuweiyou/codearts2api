/**
 * 端到端验证 `/admin` 真的能渲染出来。
 *
 * ## 为什么需要这个测试（而不是只靠 curl）
 *
 * 管理界面是「两个 script + 一个 shim」拼起来的，任何一环错位都**不会**
 * 让 HTTP 返回非 200：断掉只会得到一张白屏。故必须真的把脚本按页面顺序
 * 跑一遍、并断言渲染出了上游的界面结构。
 *
 * 这里用 jsdom 建立一个真正的 DOM，并**按 admin.html 的顺序**执行脚本：
 * ① 定义 `__ModuleLoader__` → ② 上游 bundle → ③ 本项目入口。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { JSDOM } from "jsdom"
import { startTestApp } from "./helpers.mjs"

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..")

/**
 * 在 jsdom 里按页面顺序加载脚本，返回 window。
 *
 * @param origin - 真实服务地址；页面的 rpcCall 会打到它上面。
 * @param adminKey - 管理密钥；注入成 `Authorization` 头，等价于「已登录」。
 */
function renderAdmin(origin, adminKey) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="admin-root"></div></body></html>', {
    url: `${origin}/admin`,
    pretendToBeVisual: true,
    // `outside-only` 让我们显式控制执行，不自动跑内联脚本。
    runScripts: "outside-only",
  })
  const { window } = dom

  // 浏览器里 fetch / crypto 都在 window 上；jsdom 不是都提供，从 Node 借过去
  // （admin.js 的 rpcCall 要用 randomUUID）。
  //
  // ⚠️ 必须包一层做两件事：
  //    1. 把**相对 URL 解析成绝对**：浏览器里 `fetch('/api/jet-hub')` 会用
  //       文档地址补全，而 Node 的原生 fetch 遇到相对路径直接抛 `ERR_INVALID_URL`。
  //    2. 补 `Authorization`：这里模拟的是**已登录**的浏览器。真实浏览器靠
  //       HttpOnly 会话 Cookie（jsdom 不会替我们维护 Cookie 罐），所以测试用
  //       Bearer 走同一条鉴权入口 —— 那是 `isAdminAuthorized` 的另一条分支，
  //       正因如此这里也顺带覆盖了它。
  window.fetch = (input, init = {}) => {
    const target = typeof input === "string" ? new URL(input, window.location.href).href : input
    const headers = { ...(init.headers ?? {}), authorization: `Bearer ${adminKey}` }
    return globalThis.fetch(target, { ...init, headers })
  }
  if (typeof window.crypto?.randomUUID !== "function") {
    Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true })
  }

  // ⚠️ 全部用 `window.eval` 执行：这样脚本运行在 **jsdom 自己的 realm** 里，
  //    `globalThis === window` —— 与真实浏览器一致。若改用 Node 的 `new Function`
  //    执行并传参，globalThis 仍是 Node 的，会出现「测试里失败、浏览器里正常」
  //    这类假阴性（本文件第一版就踩了这个坑）。
  const run = (file) => {
    window.eval(readFileSync(join(root, file), "utf8"))
  }

  // 按 admin.html 的顺序：① 定义 loader → ② 上游 bundle → ③ 本项目入口。
  // ⚠️ 第 ① 步不能省：上游 bundle 的第一句就调 `window.__ModuleLoader__.load`，
  //    缺了它直接抛 `Cannot read properties of undefined (reading 'load')`。
  //    ⚠️ 它现在是一个**独立文件**（`public/admin-boot.js`），不再是内联脚本 ——
  //    因为服务端配了 `script-src 'self'` 的 CSP，内联脚本会被浏览器拦掉。
  //    这里按文件名加载，等于顺带验证「那个文件真的存在且内容正确」。
  run("public/admin-boot.js")

  run("public/upstream-jet-hub.js")
  run("public/admin.js")
  return window
}

test("/admin 能渲染出上游 Jet Hub 界面", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const window = renderAdmin(app.origin, app.adminKey)
  // React 并发渲染是异步的，且页面挂载后会立刻发几条 RPC，给足时间。
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const rootElement = window.document.getElementById("admin-root")
  const html = rootElement.innerHTML

  // ① 页面外壳渲染出来了（不是白屏、也不是错误提示）。
  assert.match(html, /dim-jh-page/, "应渲染上游 Jet Hub 页面外壳")
  assert.doesNotMatch(html, /管理界面加载失败/, "不应出现加载失败提示")

  // ② 页头与品牌。
  assert.match(html, /Jet Hub/, "页头应显示 Jet Hub")

  // ③ 左侧导航：聚合面板在，且**若干个**渠道按钮都渲染出来了。
  //
  // ⚠️ 这里**故意不写死渠道名单与总数**（2026-10-21 起）：上游加渠道是常态，
  //    写死就得每次跟着改 —— 那是自动升级流水线（scripts/upgrade-upstream.mjs）
  //    最大的噪音源。现在只断言「确实渲染出了多个渠道入口 + 聚合面板存在」。
  const labels = [...rootElement.querySelectorAll(".dim-jh-rail button")].map((button) => button.textContent.trim())
  assert.ok(labels.length >= 2, `导航应至少有若干渠道入口与聚合面板，实际 ${labels.length}：${labels.join(" / ")}`)
  assert.ok(
    labels.some((label) => label.includes("聚合")),
    `导航应含聚合面板，实际：${labels.join(" / ")}`,
  )
  // 每个按钮都该有非空文案（防止上游改版后渲染出一排空按钮）。
  assert.ok(
    labels.every((label) => label.length > 0),
    `导航按钮不应有空文案，实际：${labels.join(" / ")}`,
  )

  // ④ 上游样式被注入（installJetHubStyles 走通了 document.head）。
  assert.ok(window.document.head.querySelectorAll("style").length >= 1, "应注入上游样式表")

  // ⑤ 网关入口按钮存在（用户要的「网关开启」入口）。
  assert.match(html, /dim-jh-headerActions/, "页头应有操作按钮区")
})

/**
 * 用**服务端真实返回的 admin.html** 建立 jsdom，并让浏览器自己解析执行脚本。
 *
 * ## 为什么必须补这一条（真实故障，2026-10-20）
 *
 * 上面那条用例是「手工造 DOM + 手工按顺序 eval 三个脚本」，它**测不到**脚本
 * 在文档里的**位置**。而为 CSP 把三个 `<script>` 从 `<body>` 末尾挪进 `<head>`
 * 之后，页面挂了：
 *
 * ```
 * Uncaught TypeError: Cannot set properties of null (setting 'innerHTML')
 *     at admin.js
 * ```
 *
 * 根因：`<head>` 里的普通 `<script>` 在解析到那一行时**立即执行**，此刻 `<body>`
 * 尚未解析 ⇒ `document.getElementById("admin-root")` 为 `null`。

 * ## 为什么这条用 `runScripts: "dangerously"`
 *
 * 只有让 jsdom 真的去**解析 HTML 并自行执行脚本**，脚本的先后与「执行时 DOM
 * 到哪了」才和浏览器一致。手工 eval 永远测不出这个类别的缺陷 —— 手上有 DOM，
 * 怎么写都不会 null。
 *
 * 代价是要给 jsdom 接 `fetch`（它不提供），以及脚本引用的是站内绝对路径
 * （`/admin.js`）—— jsdom 不会自己去请求它们，故仍由我们从磁盘读进来执行，
 * 但**DOM 结构来自真实 HTML**，只解析一次。
 */
test("真实 admin.html 的脚本位置正确（DOM 就绪后才执行）", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 先登录拿 Cookie，再取页面 —— 这才是用户真实的打开路径。
  const login = await fetch(`${app.origin}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    body: new URLSearchParams({ key: app.adminKey }),
    redirect: "manual",
  })
  const cookie = login.headers.get("set-cookie").split(";")[0]
  const page = await fetch(`${app.origin}/admin`, { headers: { accept: "text/html", cookie } })
  assert.equal(page.status, 200)
  const html = await page.text()

  // ① 结构断言：三个脚本必须在 </body> 之前、<body> 开始之后。
  //
  //    这条是**防回归**的核心。它比「跑一遍看有没有崩」更直接：崩了才知道，
  //    而位置错了必然会在某个浏览器上崩（不同浏览器的解析/预加载策略不同）。
  const bodyStart = html.indexOf("<body")
  const bodyEnd = html.indexOf("</body>")
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, "页面应有 body")

  for (const script of ["/admin-boot.js", "/upstream-jet-hub.js", "/admin.js"]) {
    const at = html.indexOf(`src="${script}"`)
    assert.ok(at >= 0, `页面应引用 ${script}`)
    assert.ok(at > bodyStart, `${script} 必须在 <body> 之后（否则 DOM 未就绪就执行）`)
    assert.ok(at < bodyEnd, `${script} 必须在 </body> 之前`)
  }
  // 顺序也是硬约束：垫片 → 上游 bundle → 入口。
  const bootAt = html.indexOf('src="/admin-boot.js"')
  const upstreamAt = html.indexOf('src="/upstream-jet-hub.js"')
  const entryAt = html.indexOf('src="/admin.js"')
  assert.ok(bootAt < upstreamAt && upstreamAt < entryAt, "脚本顺序应是 boot → upstream → entry")

  // ② 内容断言：不得有内联脚本 / 内联样式（否则 CSP 会拦，页面会缺样式或白屏）。
  //
  //    ⚠️ 先剥掉 HTML 注释再检查：`admin.html` 的注释里**讨论**了 `<script>`
  //    与 `<style>`（那是在解释为什么不能用内联写法），不剥离的话正则会把
  //    注释里的文字当成真的内联标签，得到一条与代码无关的假红。
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "")
  assert.doesNotMatch(
    withoutComments,
    /<script(?![^>]*\bsrc=)[^>]*>/i,
    "不应有内联 <script>（CSP script-src 'self' 会拦）",
  )
  assert.doesNotMatch(withoutComments, /<style[\s>]/i, "不应有内联 <style>（CSP style-src 'self' 会拦）")
  assert.match(html, /<link[^>]+href="\/admin\.css"/, "应有外部样式表引用")

  // ③ 行为断言：让 jsdom 解析这份真实 HTML 并执行脚本，确认不会崩。
  //
  //    把三个 src 换成本地文件的内容（jsdom 不会去请求 /admin.js），但**保持
  //    它们在文档里的位置** —— 那正是要验证的东西。
  //
  //    ⚠️ 内联前必须转义 `</script`：bundle 里是有这个字符串的（比如导出 CSV
  //    时的模板、或 React 的报错文案），直接塞进 `<script>` 会让 HTML 解析器
  //    在**那里**提前闭合脚本，得到一个与页面无关的语法错误。
  //    写法照 HTML 规范的建议：拆成 `<\/script`。
  const inline = (file) => readFileSync(join(root, file), "utf8").replace(/<\/script/gi, "<\\/script")

  const inlined = html
    .replace(/<script src="\/admin-boot\.js"><\/script>/, () => `<script>${inline("public/admin-boot.js")}</script>`)
    .replace(
      /<script src="\/upstream-jet-hub\.js"><\/script>/,
      () => `<script>${inline("public/upstream-jet-hub.js")}</script>`,
    )
    .replace(/<script src="\/admin\.js"><\/script>/, () => `<script>${inline("public/admin.js")}</script>`)

  const errors = []
  const dom = new JSDOM(inlined, {
    url: `${app.origin}/admin`,
    pretendToBeVisual: true,
    runScripts: "dangerously",
    virtualConsole: new (await import("jsdom")).VirtualConsole().on("jsdomError", (error) => {
      errors.push(error)
    }),
  })
  const { window } = dom
  window.fetch = (input, init = {}) => {
    const target = typeof input === "string" ? new URL(input, window.location.href).href : input
    const headers = { ...(init.headers ?? {}), authorization: `Bearer ${app.adminKey}` }
    return globalThis.fetch(target, { ...init, headers })
  }
  if (typeof window.crypto?.randomUUID !== "function") {
    Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true })
  }

  // DOMContentLoaded 里的脚本已同步跑完；React 渲染是异步的，给足时间。
  await new Promise((resolve) => setTimeout(resolve, 1500))

  // ⚠️ 必须为 0：「Cannot set properties of null」正是从这里冒出来的。
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
    "页面执行期间不应有任何未捕获异常",
  )

  const rendered = window.document.getElementById("admin-root").innerHTML
  assert.doesNotMatch(rendered, /正在加载管理界面/, "不应停在「正在加载」占位符上")
  assert.doesNotMatch(rendered, /管理界面加载失败/, "不应出现加载失败提示")
  assert.match(rendered, /dim-jh-page/, "应渲染出上游 Jet Hub 页面外壳")
})

test("上游 bundle 只请求我们 shim 能提供的模块", () => {
  // 这条断言守住「复用」的前提：`web/admin.jsx` 里的 `captured.factory(require)`
  // 只认 react / react-dom / 宿主 UI 原子库（后者是我们自己写的最小替身）。
  // 上游若引入**新的** external（比如又一个 UI 库），factory 会抛「未预期的模块」，
  // 界面白屏 —— 那时得同步改 shim。
  //
  // ⚠️ 断言的是**子集**而不是精确集合：上游可以不再需要 react-dom。
  //    实际发生过（2026-10-03 升级）：新版上游把 react-dom 收进内部，
  //    bundle 只剩 `require("react")`，而界面照常渲染 —— 因为**挂载是我们的
  //    入口做的**（`web/admin.jsx` 的 createRoot / createPortal）。
  //    写死 `['react','react-dom']` 会让这种「上游做了减法」的升级误报失败。
  //
  // ⚠️ 2026-10-26（换源回 iJetLi）上游新增了
  //    `@deepseek-ai/dsh-client-ui-primitives`：只用到 `Menu` 与
  //    `IconChevronDownOutlineRegular` 两个导出。我们**不装那个包**（它会拖进
  //    shiki / katex / mdast 一整条链，还有字体文件让 esbuild 直接报错），
  //    而是按本文件一贯策略在 `web/admin.jsx` 里给了等价替身 —— 所以它现在是
  //    「shim 能提供」的模块之一。
  const bundle = readFileSync(join(root, "public/upstream-jet-hub.js"), "utf8")
  const required = [...new Set([...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))]
  const supported = ["react", "react-dom", "@deepseek-ai/dsh-client-ui-primitives"]
  for (const name of required) {
    assert.ok(
      supported.includes(name),
      `上游 bundle 请求了未预期的模块 "${name}"（它只应请求 ${supported.join(" / ")}）。\n` +
        "这会让 web/admin.jsx 里的 factory(require) 抛错、/admin 白屏；" +
        "请在 web/admin.jsx 的 require 分支里补上它。",
    )
  }
  // 正面确认：至少要有 react，否则 bundle 不是我们认识的那个形态。
  assert.ok(required.includes("react"), `上游 bundle 应请求 react，实际：${required.join(", ")}`)
})
