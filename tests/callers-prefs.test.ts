/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { afterEach, test } from "vite-plus/test"

import { readAutoOn, writeAutoOn } from "../web/utils/callers-prefs.ts"

afterEach(() => window.localStorage.clear())

test("无 key 默认开启", () => {
  assert.equal(readAutoOn(), true)
})

test("旧 key(c2-rec-auto=0) 迁移到新 key(c2a-rec-auto)", () => {
  window.localStorage.setItem("c2-rec-auto", "0")
  assert.equal(readAutoOn(), false) // 关闭
  assert.equal(window.localStorage.getItem("c2a-rec-auto"), "0") // 已迁移
  assert.equal(window.localStorage.getItem("c2-rec-auto"), null) // 旧 key 删除
})

test("新 key 优先（新=0 时即使旧=1 也判为关闭）", () => {
  window.localStorage.setItem("c2a-rec-auto", "0")
  window.localStorage.setItem("c2-rec-auto", "1")
  assert.equal(readAutoOn(), false)
})

test("writeAutoOn(false) 写新 key 并清旧 key", () => {
  window.localStorage.setItem("c2-rec-auto", "1")
  writeAutoOn(false)
  assert.equal(window.localStorage.getItem("c2a-rec-auto"), "0")
  assert.equal(window.localStorage.getItem("c2-rec-auto"), null)
})

test("writeAutoOn(true) 清新 key 并清旧 key", () => {
  window.localStorage.setItem("c2a-rec-auto", "0")
  window.localStorage.setItem("c2-rec-auto", "0")
  writeAutoOn(true)
  assert.equal(window.localStorage.getItem("c2a-rec-auto"), null)
  assert.equal(window.localStorage.getItem("c2-rec-auto"), null)
})
