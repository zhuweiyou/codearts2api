/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"

import { SecretModal } from "../web/pages/callers/SecretModal.tsx"

afterEach(cleanup)

test("Esc 不关闭（onClose 不被调用），只提示先复制", () => {
  const onClose = vi.fn()
  render(<SecretModal secret="sk-abc" onClose={onClose} />)
  fireEvent.keyDown(document, { key: "Escape" })
  assert.ok(screen.queryByRole("dialog")) // 弹窗仍在
  assert.equal(onClose.mock.calls.length, 0) // 未关闭
  assert.match(screen.getByText(/只显示一次，请先复制/).textContent ?? "", /请先复制/)
})

test("渲染明文 Key 与两个按钮", () => {
  render(<SecretModal secret="sk-abc" onClose={() => {}} />)
  assert.ok(screen.getByText("sk-abc"))
  assert.ok(screen.getByRole("button", { name: "复制 Key" }))
  assert.ok(screen.getByRole("button", { name: "关闭" }))
})
