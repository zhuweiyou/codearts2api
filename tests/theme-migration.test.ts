/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { test, vi } from "vite-plus/test"

test("旧主题 key(c2-theme) 迁移到新 key(c2a-theme)", async () => {
  vi.resetModules()
  window.localStorage.clear()
  window.localStorage.setItem("c2-theme", "dark")

  // 动态 import：模块初始化时会 readTheme() 触发迁移
  const mod = await import("../web/store/theme.ts")

  assert.equal(window.localStorage.getItem("c2a-theme"), "dark")
  assert.equal(window.localStorage.getItem("c2-theme"), null)
  assert.equal(mod.useThemeStore.getState().theme, "dark")
})

test("无旧 key 时默认 auto，且不产生新 key", async () => {
  vi.resetModules()
  window.localStorage.clear()
  const mod = await import("../web/store/theme.ts")
  assert.equal(mod.useThemeStore.getState().theme, "auto")
  assert.equal(window.localStorage.getItem("c2a-theme"), null)
})
