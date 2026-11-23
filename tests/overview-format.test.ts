import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { cacheHitRate, fmt, fmtAmt, fmtTokens, leftDays } from "../web/pages/overview/format.ts"

test("fmt：千分位与空值", () => {
  assert.equal(fmt(1234), "1,234")
  assert.equal(fmt(0), "0")
  assert.equal(fmt(null), "—")
  assert.equal(fmt(NaN), "—")
})

test("fmtTokens：亿/万/普通", () => {
  assert.equal(fmtTokens(2e8), "2.00 亿")
  assert.equal(fmtTokens(12345), "1.2 万")
  assert.equal(fmtTokens(500), "500")
  assert.equal(fmtTokens(undefined), "0")
})

test("fmtAmt：整数去小数、非整数保留两位、非法归零", () => {
  assert.equal(fmtAmt(12), "12")
  assert.equal(fmtAmt(12.5), "12.50")
  assert.equal(fmtAmt("x"), "0")
})

test("leftDays：无到期返回 null，未来返回天数", () => {
  assert.equal(leftDays(null), null)
  assert.equal(leftDays(undefined), null)
  const days = leftDays(Date.now() + 5 * 86400_000)
  assert.ok(days === 4 || days === 5, `期望 4/5 天，实际 ${days}`)
})

test("cacheHitRate：缺输入用量时显示 —，不能算成 100%", () => {
  assert.equal(cacheHitRate(100, 50), "33.3")
  assert.equal(cacheHitRate(10, 0), "0.0")
  // 请求没经过本服务反代时 caller-usage 为空，而 ledger 仍有缓存读
  assert.equal(cacheHitRate(0, 188_000_000), "—")
  assert.equal(cacheHitRate(undefined, 10), "—")
})
