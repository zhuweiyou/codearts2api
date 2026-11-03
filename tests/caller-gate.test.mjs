/**
 * 调用方闸门（caller-gate）的回归测试。
 *
 * ## 为什么这组测试很重要
 *
 * 闸门是**旁挂**在 `proxyToGateway` 之前的鉴权层：它一旦判错，后果只有两种，
 * 而且都不报错 —— 要么放行了本该拒绝的调用（白名单失效、停用的 key 还能用、
 * 已关闭的模型还能调），要么拒绝了本该放行的调用（整站 401）。
 *
 * 所以这里断言的是**判定的边界**，不是某个功能：
 *
 * 1. 没有 `caller-keys.json` 时整层不生效（默认关闭，行为与改造前完全一致）；
 * 2. 未知 key 401、停用 key 403、分组缺失 403 —— 三种「进不来」不能混成一条；
 * 3. 白名单与模型关闭表是**叠加**关系：白名单不过时不该泄露「模型在网关上被关了」
 *    这条信息，所以关闭表的判定必须排在白名单之后；
 * 4. `filterModels` 会把无权模型从 `/v1/models` 里摘掉，且不保留聚合路由。
 *
 * ## 为什么直接单测而不是起服务
 *
 * 判定逻辑全在 `inspect` 里，起一个 HTTP 服务只会把断言变成「测 fetch 库」。
 * 这里用假的 request（一个带 `headers` 的 Readable）就能覆盖全部分支，
 * 唯一的例外是 `/relay/*` 的鉴权 —— 那条属于 server.js 的鉴权门，在
 * `oauth-relay.test.mjs` 里断言。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { _internal, createCallerGate } from "../src/caller-gate.js"

const { sha256 } = _internal

const FULL_KEY = "sk-full-0123456789abcdef"
const BASIC_KEY = "sk-basic-0123456789abcdef"
const OFF_KEY = "sk-off-0123456789abcdef"
const ORPHAN_KEY = "sk-orphan-0123456789abcdef"
const UNKNOWN_KEY = "sk-unknown-0123456789abcdef"

const CHAT = new URL("http://127.0.0.1/v1/chat/completions")

/**
 * 造一个装了 `caller-keys.json` 的 home。
 *
 * `groups` 覆盖默认分组表；`disabledModels` 非空时顺带写 `jet-hub/state.json`
 * （模型关闭表的镜像源）。
 */
function makeHome(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "c2a-gate-"))
  if (options.store !== false) {
    const store = {
      version: 1,
      groups: options.groups ?? [
        { name: "full", allow: ["*"] },
        { name: "basic", allow: ["codearts/*"] },
      ],
      keys: [
        { id: "k-full", name: "全量", group: "full", sha256: sha256(FULL_KEY) },
        { id: "k-basic", name: "基础", group: "basic", sha256: sha256(BASIC_KEY) },
        { id: "k-off", name: "已停用", group: "full", enabled: false, sha256: sha256(OFF_KEY) },
        { id: "k-orphan", name: "孤儿", group: "nope", sha256: sha256(ORPHAN_KEY) },
      ],
    }
    writeFileSync(join(home, "caller-keys.json"), JSON.stringify(store, null, 2), "utf8")
  }
  if (options.disabledModels) {
    mkdirSync(join(home, "jet-hub"), { recursive: true })
    writeFileSync(
      join(home, "jet-hub", "state.json"),
      JSON.stringify({ disabledModels: options.disabledModels, providerClosed: {} }),
      "utf8",
    )
  }
  return home
}

/**
 * 造一个假 request。
 *
 * `readBodyCapped` 只用 `on("data"|"end"|"error")` 与 `destroy()`，
 * 所以一个 `Readable.from(...)` 加个 `headers` 属性就够。
 */
function fakeRequest(key, body, method = "POST") {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body, "utf8")])
  request.method = method
  request.headers = key === null ? {} : { authorization: `Bearer ${key}` }
  return request
}

test("没有 caller-keys.json 时闸门整层不生效（默认关闭）", async () => {
  const home = makeHome({ store: false })
  const gate = createCallerGate({ home })
  // 连 Bearer 都不带也应该放行：闸门没开时它必须对流量完全透明。
  const verdict = await gate.inspect(fakeRequest(null, '{"model":"anything"}'), CHAT, "POST")
  assert.equal(verdict.ok, true)
  assert.equal(verdict.disabled, true)
  // /v1/models 也不该被过滤（否则等于闸门关闭状态下仍在改行为）。
  const payload = { object: "list", data: [{ id: "codearts/gpt-4" }, { id: "aggregate/auto" }] }
  assert.deepEqual(gate.filterModels(payload, null), payload)
  // tapStream 必须原样返回 source，一个字节都不碰。
  const source = Readable.from([Buffer.from("data: {}\n\n")])
  assert.equal(gate.tapStream(source, {}), source)
})

test("未知 key 返回 401 invalid_api_key", async () => {
  const gate = createCallerGate({ home: makeHome() })
  const verdict = await gate.inspect(fakeRequest(UNKNOWN_KEY, '{"model":"codearts/gpt-4"}'), CHAT, "POST")
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 401)
  assert.equal(verdict.error.code, "invalid_api_key")
  assert.equal(verdict.error.type, "invalid_request_error")
  assert.equal(verdict.error.message, "Invalid API key provided.")
})

test("已停用的 key 返回 403 key_disabled，指向不存在分组的 key 返回 403 group_missing", async () => {
  const gate = createCallerGate({ home: makeHome() })

  const disabled = await gate.inspect(fakeRequest(OFF_KEY, '{"model":"codearts/gpt-4"}'), CHAT, "POST")
  assert.equal(disabled.ok, false)
  assert.equal(disabled.status, 403)
  assert.equal(disabled.error.code, "key_disabled")

  // 分组缺失必须单独一条：它和「key 被停用」「白名单不过」是不同的运维动作。
  const orphan = await gate.inspect(fakeRequest(ORPHAN_KEY, '{"model":"codearts/gpt-4"}'), CHAT, "POST")
  assert.equal(orphan.ok, false)
  assert.equal(orphan.status, 403)
  assert.equal(orphan.error.code, "group_missing")
})

test("白名单不过返回 403 model_not_allowed，且聚合路由必须显式授权", async () => {
  const gate = createCallerGate({ home: makeHome() })

  // basic 只放 codearts/*，所以 codearts 的模型能过。
  const allowed = await gate.inspect(fakeRequest(BASIC_KEY, '{"model":"codearts/gpt-4"}'), CHAT, "POST")
  assert.equal(allowed.ok, true)
  assert.equal(allowed.model, "codearts/gpt-4")

  const denied = await gate.inspect(fakeRequest(BASIC_KEY, '{"model":"zcode/glm-4"}'), CHAT, "POST")
  assert.equal(denied.ok, false)
  assert.equal(denied.status, 403)
  assert.equal(denied.error.code, "model_not_allowed")

  // aggregate/* 会跨渠道选号，等于绕过「只准用某渠道」，因此默认拒绝。
  const aggregate = await gate.inspect(fakeRequest(BASIC_KEY, '{"model":"aggregate/auto"}'), CHAT, "POST")
  assert.equal(aggregate.ok, false)
  assert.equal(aggregate.status, 403)
  assert.equal(aggregate.error.code, "model_not_allowed")
  assert.match(aggregate.error.message, /聚合路由/)

  // jet-hub-auto/ 是第二个聚合前缀，同样默认拒绝。
  const jetHubAuto = await gate.inspect(fakeRequest(BASIC_KEY, '{"model":"jet-hub-auto/x"}'), CHAT, "POST")
  assert.equal(jetHubAuto.error.code, "model_not_allowed")
  assert.match(jetHubAuto.error.message, /聚合路由/)

  // ⚠️ 防回退：上面两条「聚合路由」文案曾经永远走不到 —— `AGGREGATE_PREFIXES`
  //    写成 `["aggregate/", ...]` 而 `patternToRegExp` 是全锚定 `^…$`，于是
  //    `^aggregate\/$` 匹配不了 `aggregate/auto`，守卫成了死代码，聚合成员只能
  //    靠普通白名单兜住（文案变成「不在该分组的白名单内」）。这里用「显式授权
  //    一个聚合成员、但同组其它聚合成员仍被拒」把分支钉住：一旦前缀又退回不带
  //    `*` 的形状，`aggregate/other` 就会落到白名单文案，断言失败。
  const mixed = createCallerGate({
    home: makeHome({ groups: [{ name: "basic", allow: ["codearts/*", "aggregate/auto"] }] }),
  })
  const explicit = await mixed.inspect(fakeRequest(BASIC_KEY, '{"model":"aggregate/auto"}'), CHAT, "POST")
  assert.equal(explicit.ok, true, "显式列入 allow 的聚合成员必须放行")
  const other = await mixed.inspect(fakeRequest(BASIC_KEY, '{"model":"aggregate/other"}'), CHAT, "POST")
  assert.equal(other.error.code, "model_not_allowed")
  assert.match(other.error.message, /聚合路由/, "同组未被显式授权的聚合成员仍须命中聚合守卫")
})

test("模型关闭表返回 403 model_disabled，且排在白名单之后、不写用量日志", async () => {
  const home = makeHome({ disabledModels: { codearts: { "gpt-4": true } } })
  const gate = createCallerGate({ home })

  const blocked = await gate.inspect(fakeRequest(FULL_KEY, '{"model":"codearts/gpt-4"}'), CHAT, "POST")
  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, 403)
  assert.equal(blocked.error.code, "model_disabled")
  assert.match(blocked.error.message, /重新打开该模型/)

  // ⚠️ 顺序断言：同一个模型、同一条关闭记录，basic 分组必须报「白名单不过」而不是
  //    「模型被关闭」——否则等于向无权调用方泄露网关的模型开关状态。
  const basic = await gate.inspect(fakeRequest(BASIC_KEY, '{"model":"aggregate/x"}'), CHAT, "POST")
  assert.equal(basic.error.code, "model_not_allowed")

  // 403 在 log() 之前返回，所以用量目录必须始终不存在。
  assert.equal(existsSync(gate.logDir), false, "被拒绝的请求不应产生用量记录")
})

test("filterModels 摘掉无权模型，未授权时也不保留聚合路由", async () => {
  const gate = createCallerGate({ home: makeHome() })
  const payload = {
    object: "list",
    data: [{ id: "codearts/gpt-4" }, { id: "zcode/glm-4" }, { id: "aggregate/auto" }],
  }
  // full 分组：原样保留全部。
  const full = await gate.inspect(fakeRequest(FULL_KEY, '{"model":"codearts/gpt-4"}'), CHAT, "POST")
  assert.deepEqual(
    gate.filterModels(payload, full.entry).data.map((item) => item.id),
    ["codearts/gpt-4", "zcode/glm-4", "aggregate/auto"],
  )
  // basic 分组：只剩 codearts/*。
  const basic = await gate.inspect(fakeRequest(BASIC_KEY, '{"model":"codearts/gpt-4"}'), CHAT, "POST")
  assert.deepEqual(
    gate.filterModels(payload, basic.entry).data.map((item) => item.id),
    ["codearts/gpt-4"],
  )
  // 非模型路径（unbuffered）没有 entry 归一后的 model，这里用 null entry 兜底。
  assert.deepEqual(gate.filterModels(payload, null), payload)
})

test("非模型路径与 GET 只做鉴权、不读请求体（streaming 透传）", async () => {
  const gate = createCallerGate({ home: makeHome() })
  const other = new URL("http://127.0.0.1/v1/files")
  const verdict = await gate.inspect(fakeRequest(FULL_KEY, undefined, "GET"), other, "GET")
  assert.equal(verdict.ok, true)
  assert.equal(verdict.unbuffered, true)
  assert.equal(verdict.entry.id, "k-full")
})

test("用量日志目录只有真实放行的请求才会被创建", async () => {
  const gate = createCallerGate({ home: makeHome() })
  const home = dirname(gate.storePath)

  const ok = await gate.inspect(fakeRequest(FULL_KEY, '{"model":"codearts/gpt-4"}'), CHAT, "POST")
  assert.equal(ok.ok, true)

  // 判定通过不等写用量：logDir 只有在 tapStream 真的看到 usage 时才创建。
  assert.equal(existsSync(gate.logDir), false)

  // 直接写一条，验证落盘格式（不经过 HTTP 流，避免测试依赖 Transform 时序）。
  const ts = "2026-01-01T00:00:00.000Z"
  await gate.log({ ts, caller: "k-full", model: "codearts/gpt-4", status: 200 })

  // 文件名按「写入当天」滚动，不取 entry.ts，所以这里只能断言形状。
  const files = readdirSync(gate.logDir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/)
  assert.ok(existsSync(join(home, "caller-usage", files[0])))

  // 而 entry.ts 必须原样进到行内容里。
  const line = JSON.parse(readFileSync(join(home, "caller-usage", files[0]), "utf8").trim())
  assert.equal(line.ts, ts)
  assert.equal(line.caller, "k-full")
  assert.equal(line.model, "codearts/gpt-4")
  assert.equal(line.status, 200)
})
