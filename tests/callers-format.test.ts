import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { daysText, fmt, fmtMs, presetSet, recKey, sameSet, statusReason } from "../web/utils/callers-format.ts"

test("fmt / fmtMs", () => {
  assert.equal(fmt(1234), "1,234")
  assert.equal(fmtMs(500), "500 ms")
  assert.equal(fmtMs(1500), "1.5 s")
  assert.equal(fmtMs(65000), "1 分 05 秒")
  assert.equal(fmtMs(null), "—")
})

test("statusReason：按 error_code / status 归类", () => {
  assert.equal(statusReason({ status: 429 }), "被限流")
  assert.equal(statusReason({ status: 401 }), "Key 无效")
  assert.equal(statusReason({ error_code: "insufficient_quota" }), "额度不足")
  assert.equal(statusReason({ status: 599 }), "服务出错")
})

test("recKey：稳定拼接去重键", () => {
  const key = recKey({ ts: 1, caller: "a", model: "m", status: 200, ms: 10, in_tokens: 1, out_tokens: 2 })
  assert.equal(key, "1|a|m|200|10|1|2")
})

test("daysText：空/单日/多日", () => {
  assert.equal(daysText([]), "未选择 · 默认今天")
  assert.ok(daysText(["2026-11-16"]).startsWith("2026-11-16"))
  assert.equal(daysText(["2026-11-15", "2026-11-16"]), "已选 2 天 · 2026-11-15 → 2026-11-16")
})

test("presetSet / sameSet", () => {
  assert.deepEqual(presetSet("3", ["a", "b", "c", "d"]), ["a", "b", "c"])
  assert.deepEqual(presetSet("none", ["a"]), [])
  assert.equal(presetSet("unknown", []), null)
  assert.equal(sameSet(["b", "a"], ["a", "b"]), true)
  assert.equal(sameSet(["a"], ["a", "b"]), false)
})
