/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, test, vi } from "vite-plus/test"

const { replayMock } = vi.hoisted(() => ({ replayMock: vi.fn() }))
vi.mock("../web/api/oauth-relay.ts", () => ({ replayOAuthCallback: replayMock }))

import { OAuthRelayFix } from "../web/components/OAuthRelayFix.tsx"

const O = () => window.location.origin

function openModal() {
  render(<OAuthRelayFix />)
  fireEvent.click(screen.getByRole("button", { name: "回调修复" }))
  return screen.getByRole("textbox") as HTMLTextAreaElement
}

beforeEach(() => replayMock.mockReset())
afterEach(cleanup)

test("点击顶栏按钮打开弹窗", () => {
  render(<OAuthRelayFix />)
  assert.equal(screen.queryByRole("dialog"), null)
  fireEvent.click(screen.getByRole("button", { name: "回调修复" }))
  assert.ok(screen.getByRole("dialog"))
})

test("粘贴 loopback → 提交给重放接口的是 loopback", async () => {
  replayMock.mockResolvedValue({ ok: true, status: 200, port: 19283 })
  const textarea = openModal()
  fireEvent.change(textarea, { target: { value: "http://127.0.0.1:19283/cb" } })
  fireEvent.click(screen.getByRole("button", { name: "重放" }))
  await waitFor(() => assert.equal(replayMock.mock.calls.length, 1))
  assert.equal(replayMock.mock.calls[0][0], "http://127.0.0.1:19283/cb")
})

test("粘贴本站 /relay/<port> → 提交前还原成 loopback", async () => {
  replayMock.mockResolvedValue({ ok: true, status: 200, port: 19283 })
  const textarea = openModal()
  fireEvent.change(textarea, { target: { value: `${O()}/relay/19283/auth/cb?code=x` } })
  fireEvent.click(screen.getByRole("button", { name: "重放" }))
  await waitFor(() => assert.equal(replayMock.mock.calls.length, 1))
  assert.equal(replayMock.mock.calls[0][0], "http://127.0.0.1:19283/auth/cb?code=x")
})

test("端口 80 → 提示格式不对且重放按钮 disabled", () => {
  const textarea = openModal()
  fireEvent.change(textarea, { target: { value: "http://127.0.0.1:80/x" } })
  assert.ok(screen.getByText(/格式不对/))
  assert.equal((screen.getByRole("button", { name: "重放" }) as HTMLButtonElement).disabled, true)
})

test("Esc 关闭弹窗", () => {
  openModal()
  fireEvent.keyDown(document, { key: "Escape" })
  assert.equal(screen.queryByRole("dialog"), null)
})

test("busy 时按 Esc 不关闭", async () => {
  let resolveFn: (value: unknown) => void = () => {}
  replayMock.mockReturnValue(new Promise((resolve) => (resolveFn = resolve)))
  const textarea = openModal()
  fireEvent.change(textarea, { target: { value: "http://127.0.0.1:19283/cb" } })
  fireEvent.click(screen.getByRole("button", { name: "重放" }))
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "重放中…" })))
  fireEvent.keyDown(document, { key: "Escape" })
  assert.ok(screen.queryByRole("dialog")) // 仍打开
  resolveFn({ ok: true, status: 200, port: 19283 }) // 收尾，避免悬挂
  await Promise.resolve()
})
