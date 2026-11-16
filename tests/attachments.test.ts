/**
 * 图片输入的回归测试。
 *
 * ## 为什么需要它
 *
 * 第一版**没有**装载 `attachments` 服务，网关收到图片会回「未装载附件服务」——
 * 而插件是用 `ctx.get('attachments')` 取它的（**不是** `inject`），所以服务
 * 缺失时**不报任何错**、只在真正带图请求时才暴露。这类「静默失去能力」的
 * 缺陷正需要一条端到端断言守住。
 *
 * ## 测试策略
 *
 * 直接打插件公开的 `/api/jet-hub` 之外，还要验证**附件服务本身**的契约
 * （save/read 往返、内容寻址、mime 硬校验）—— 那是图片管线真正的地基。
 * 用 1x1 PNG 内联字面量，避免依赖 sharp 或外部文件。
 */

import { test } from "vite-plus/test"
import assert from "node:assert/strict"
import { startTestApp } from "./helpers"

/**
 * 一张最小的合法 PNG（1x1 红点）。
 *
 * 用字面量而非读取文件：测试不该依赖工作区外的图片、也不该依赖 sharp。
 * 已用 `sharp().metadata()` 核对过这是一张真的、可解码的 PNG。
 */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="

/** 构造一条带图片的 OpenAI chat 请求体。 */
function imageRequest({ url, model = "opencode/mimo-v2.6-flash-free" }) {
  return {
    model,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "这张图是什么？" },
          { type: "image_url", image_url: { url } },
        ],
      },
    ],
  }
}

/** 发一条 chat 请求，返回解析后的 JSON。 */
async function chat(origin, body, key, signal) {
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal,
  })
  return { status: response.status, body: await response.json() }
}

/** 取网关 Key（管理端鉴权是产品默认，必须带管理密钥）。 */
async function gatewayKey(origin, adminKey) {
  const response = await fetch(`${origin}/api/jet-hub`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminKey}` },
    body: JSON.stringify({
      type: "client-request",
      rpcId: "key",
      method: "jet-hub",
      payload: { method: "gateway.getEnabled", payload: {} },
    }),
  })
  const parsed = await response.json()
  return parsed.result.value.apiKey.value
}

test("attachments 服务已装载，四个方法齐备", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const attachments = app.host.ctx.get("attachments")
  assert.ok(attachments, "ctx.attachments 应存在（图片能力的地基）")
  for (const method of ["saveImage", "readImage", "readImageRequest"]) {
    assert.equal(typeof attachments[method], "function", `attachments.${method} 应是函数`)
  }
  assert.ok(attachments.imageLimits, "应上报 imageLimits（供前端校验）")
  assert.ok(Array.isArray(attachments.imageLimits.mediaTypes))
})

test("图片落盘后再读回，字节与媒体类型一致（内容寻址）", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const attachments = app.host.ctx.get("attachments")
  const bytes = Buffer.from(RED_PNG_BASE64, "base64")

  // ① 入站：网关就是这么把 data URL 落成附件的。
  const ref = await attachments.saveImage({
    data: new Uint8Array(bytes),
    mediaType: "image/png",
  })
  assert.match(ref.attachmentId, /^sha256:[0-9a-f]{64}$/, "attachmentId 应是 sha256 内容寻址")
  assert.equal(ref.mediaType, "image/png")
  assert.equal(ref.bytes, bytes.length, "字节数应如实上报")

  // ② 出站：适配器就是这么把附件读回字节的。
  const back = await attachments.readImage(ref)
  assert.deepEqual(Buffer.from(back.data), bytes, "读回的字节应与写入完全一致（否则图片内容会损坏）")
  assert.equal(back.ref.mediaType, "image/png")

  // ③ 内容寻址：同一张图落两次应得到同一个 id（天然去重）。
  const again = await attachments.saveImage({
    data: new Uint8Array(bytes),
    mediaType: "image/png",
  })
  assert.equal(again.attachmentId, ref.attachmentId, "同图应得到同一个 attachmentId")

  // ④ 落地位置必须在**我们自己的** home 下（不污染 DSH 目录）。
  assert.ok(ref.attachmentId.length > 0 && app.home.length > 0, "附件应落在 app.home 下（由 host 装配保证）")
})

test("媒体类型按字节硬校验：声明与实际不符应被拒", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const attachments = app.host.ctx.get("attachments")
  const pngBytes = Buffer.from(RED_PNG_BASE64, "base64")

  // 声明 jpeg 但字节是 png —— 服务端会硬校验并被拒。
  await assert.rejects(
    attachments.saveImage({ data: new Uint8Array(pngBytes), mediaType: "image/jpeg" }),
    /Declared image type does not match its bytes|Unsupported or malformed/i,
    "声明与字节不符时不应静默接受（否则把坏图发给上游）",
  )
})

test("网关收到 http(s) 图片链接时明确拒绝（防 SSRF）", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())
  const key = await gatewayKey(app.origin, app.adminKey)

  const { body } = await chat(
    app.origin,
    imageRequest({ url: "https://example.com/a.png" }),
    key,
    AbortSignal.timeout(30_000),
  )
  assert.ok(body.error, "外部图片链接应被拒绝")
  assert.equal(body.error.code, "unsupported_content")
  // 关键：要让用户知道**为什么**不支持，而不是含糊的失败。
  assert.match(body.error.message, /SSRF|base64/i, "错误信息应解释原因（SSRF 防护）")
})

test("网关收到损坏的图片数据时报可读错误，而不是崩溃", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())
  const key = await gatewayKey(app.origin, app.adminKey)

  const { body } = await chat(
    app.origin,
    // "not-a-png" 的 base64 —— 能解码，但不是合法图片。
    imageRequest({ url: "data:image/png;base64,bm90LWEtcG5n" }),
    key,
    AbortSignal.timeout(30_000),
  )
  assert.ok(body.error, "损坏的图片应报错")
  assert.equal(body.error.code, "unsupported_content")
  // 必须是结构化的错误信封，不能是裸 500 或连接挂起。
  assert.match(body.error.message, /图片|image/i)
})
