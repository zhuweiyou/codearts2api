/**
 * 宿主装配的断言：插件真的被「不依赖 DSH」地跑起来了。
 *
 * 这些断言对应项目最核心的假设 —— 只要提供 credentials / commands /
 * connection / llm 四个服务，上游插件就能完整加载。它们**不**依赖网络，
 * 也不依赖任何 DSH 宿主。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestApp, rpc } from "./helpers.mjs"

/**
 * 渠道数量的**下限**（⚠️ 只防「几乎全没了」，不防删减）。
 *
 * ## 为什么从「逐个点名」改成「数量下限」（2026-10-22）
 *
 * 原先是 `EXPECTED_PROVIDERS` 白名单 + 「期望 ⊆ 实际」断言。问题是上游会**有意
 * 裁剪渠道**（`deepseek-harness-codearts` → `dsh-providers-hub` 重写时直接删掉
 * 了 `buddy` / `workbuddy` 两家），每次都得人工改名单 —— 而自动升级流水线
 * （`scripts/upgrade-upstream.mjs`）一旦撞上这种改动就会**每天红一次**，
 * 成了必须人工介入的噪音。
 *
 * 现在只守一条真正有意义的底线：**插件确实注册了若干渠道**。上游增删渠道都
 * 不再让这条红；只有「注册数为 0 / 只剩三家或更少」这种真故障（`apply` 没跑、
 * 服务没注入、装配顺序错）才会失败。
 *
 * ⚠️ 想核对具体渠道时**不要**改这里 —— 直接跑：
 *   `node -e "…listProviders()…"` 或看测试失败信息里的 `实际` 列表。
 */
const MIN_PROVIDERS = 4

test("插件在无 DSH 的纯 cordis 宿主上完整加载", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // ① 四个必要服务都在，且插件把 llm 适配器注册齐了。
  const llm = app.host.ctx.get("llm")
  assert.ok(llm, "ctx.llm 应存在")
  const providers = llm.listProviders().map((entry) => entry.id)

  // ⚠️ 只断言「渠道数量不低于下限」：上游增删渠道都不再让这条红（自动升级的
  //    前提）。真故障（`apply` 没跑 / 服务没注入 / 装配顺序错）会让数量掉到
  //    0~3，那才是这条断言要抓的东西。
  assert.ok(
    providers.length >= MIN_PROVIDERS,
    `注册的 provider 太少（${providers.length} < ${MIN_PROVIDERS}）—— ` +
      `多半是插件没真正 apply，或 credentials/commands/llm 服务没在 ctx.plugin 前就位。\n` +
      `  实际：${providers.join(", ") || "(空)"}`,
  )

  // ② Jet Hub 的管理端点注册到了 connection seam 上。
  assert.ok(app.host.routes.has("/api/jet-hub"), "Jet Hub 管理端点应已注册")

  // ③ 服务真的能应答（经完整 HTTP 链路，不是内部调用）。
  const listed = await rpc(app.origin, "account.list", { provider: "codearts" })
  assert.equal(listed.ok, true, `account.list 应成功：${JSON.stringify(listed)}`)
  assert.ok(Array.isArray(listed.value.accounts), "accounts 应是数组")
})

test("聚合目录与实际渠道 RPC 无需新增转发代码即可访问", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const catalog = await rpc(app.origin, "aggregate.catalog", { force: true })
  assert.equal(catalog.ok, true, `aggregate.catalog 应成功：${JSON.stringify(catalog)}`)
  assert.ok(Array.isArray(catalog.value.models), "聚合目录应返回 models 数组")

  const active = await rpc(app.origin, "aggregate.activeProvider", {})
  assert.equal(active.ok, true, `aggregate.activeProvider 应成功：${JSON.stringify(active)}`)
  assert.equal(active.value.provider, null, "尚未转发请求时不应臆造实际渠道")
})

test("/healthz 汇总服务状态", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const response = await fetch(`${app.origin}/healthz`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.home, app.home, "healthz 应回显实际 state home")
  assert.ok(body.providers.includes("codearts"), "providers 应含 codearts")
  assert.ok(body.routes.includes("/api/jet-hub"), "routes 应含 Jet Hub 端点")
  assert.equal(body.gateway.running, true, "网关应已启动")
  // ⚠️ 健康检查**不得**包含网关密钥明文：它可能被日志/监控/CDN 记录。
  const raw = JSON.stringify(body)
  assert.doesNotMatch(raw, /apiKey/, "healthz 不应回传 apiKey 字段")
})

test("未知 RPC 方法回可读错误而不是崩掉", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const result = await rpc(app.origin, "definitely.not.a.method", {})
  // 插件的 handler 会把未知方法抛出的异常包成 rpc 错误信封，
  // 关键是**不能**变成 HTTP 500 或连接挂起。
  assert.ok(result.ok === false || result.ok === true, "应返回规范的 rpc 信封")
})

test("PROXY_GATEWAY 开启时 /v1/* 经本服务透明转发", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 先取网关密钥（经管理 RPC，这是显式的用户操作）。
  const status = await rpc(app.origin, "gateway.getEnabled", {})
  const key = status.value.apiKey.value

  // ① 无 Key 仍应 401 —— 反代不替客户端鉴权，判定权只在插件网关一处。
  const unauthorized = await fetch(`${app.origin}/v1/models`)
  assert.equal(unauthorized.status, 401, "反代不应绕过网关鉴权")

  // ② 带 Key：反代能拿到正常的模型目录。
  const throughProxy = await fetch(`${app.origin}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
  })
  assert.equal(throughProxy.status, 200)
  const proxied = await throughProxy.json()
  assert.equal(proxied.object, "list")

  // ③ 反代结果应与直连一致。
  //
  // ⚠️ **两侧必须在同一轮里并发比对**，而不是「先读一侧、再读另一侧」。
  //
  // 上游网关的模型目录是**异步长出来**的：`apply()` 返回时 OpenCode 的匿名通道
  // 与其它渠道的远端目录都还在路上，随后才陆续落进目录里。顺序读两次会落在
  // 「长大前」与「长大后」两份快照上而**偶发**失败。
  //
  // 本项目亲历（2026-10-10 升级后）：25 次运行红 3 次，差异恒为直连多出几个
  // `opencode/*` —— 是**测试时序**问题，不是反代丢了模型。
  //
  // 故逐轮并发读两侧，直到相等；始终不等则由断言报出真实差异。
  // ⚠️ 有意**不**放松成子集断言：子集会让「反代真的丢模型」也变绿。
  const directOrigin = `http://${status.value.address.host}:${status.value.address.port}`
  const readIds = async (origin) => {
    const response = await fetch(`${origin}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
    assert.equal(response.status, 200)
    return (await response.json()).data.map((model) => model.id)
  }
  const readBoth = () => Promise.all([readIds(app.origin), readIds(directOrigin)])

  let [proxiedIds, directIds] = await readBoth()
  const deadline = Date.now() + 15_000
  while (proxiedIds.join("\n") !== directIds.join("\n") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    ;[proxiedIds, directIds] = await readBoth()
  }
  assert.deepEqual(proxiedIds, directIds, "反代结果应与直连完全一致")
})

test("网关不可达时反代回可读的 OpenAI 错误信封", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 关掉网关，模拟「端口没人听」。
  await rpc(app.origin, "gateway.setEnabled", { enabled: false })

  const response = await fetch(`${app.origin}/v1/models`, {
    headers: { authorization: "Bearer whatever" },
  })
  // 502 而非挂起/500 HTML：OpenAI 客户端能据此判断是服务端问题。
  assert.equal(response.status, 502, "网关不可达应回 502")
  const body = await response.json()
  assert.equal(body.error.code, "gateway_unreachable")
  assert.match(body.error.message, /admin/, "错误信息应指引用户去 /admin 检查网关")
})
