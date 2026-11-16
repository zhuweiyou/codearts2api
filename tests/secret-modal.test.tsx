/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, test } from "vite-plus/test"

import { SecretModal } from "../web/pages/callers/SecretModal.tsx"

afterEach(cleanup)

test("Esc 不关闭，只提示先复制", () => {
  render(<SecretModal secret="sk-abc" onClose={() => {}} />)
  fireEvent.keyDown(document, { key: "Escape" })
  // 弹窗仍在
  assert.ok(screen.queryByRole("dialog"))
  // 出现「先复制」提示
  assert.match(screen.getByText(/只显示一次，请先复制/).textContent ?? "", /请先复制/)
})

test("渲染明文 Key 与两个按钮", () => {
  render(<SecretModal secret="sk-abc" onClose={() => {}} />)
  assert.ok(screen.getByText("sk-abc"))
  assert.ok(screen.getByRole("button", { name: "复制 Key" }))
  assert.ok(screen.getByRole("button", { name: "关闭" }))
})
