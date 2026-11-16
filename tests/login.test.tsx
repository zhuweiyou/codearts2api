/** @vitest-environment jsdom */
/**
 * 登录前端化后的组件契约：
 * - 登录成功后回跳目标来自 ?next=，没有 next 时必须回当前页面（不能一律回总览）。
 * - 错误响应要显示给用户，而不是静默失败。
 * - AuthGate 未登录展示 Login，已登录渲染后台。
 */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"

import { AuthGate } from "../web/components/AuthGate.tsx"
import { Login } from "../web/components/Login.tsx"

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState({}, "", "/")
})

test("直接访问 /admin/callers 时，登录成功回跳当前页面（不再一律回总览）", async () => {
  window.history.replaceState({}, "", "/admin/callers?tab=keys")
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(jsonResponse({ ok: true, next: "/admin/callers?tab=keys" }))
  const onSuccess = vi.fn()

  render(<Login onSuccess={onSuccess} />)
  fireEvent.change(screen.getByLabelText("访问密钥"), { target: { value: "secret" } })
  fireEvent.click(screen.getByRole("button", { name: "进入后台" }))

  await waitFor(() => assert.equal(onSuccess.mock.calls.length, 1))
  const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
  assert.equal(body.next, "/admin/callers?tab=keys")
})

test("登录页自身没有 next 时回总览，不会把 /admin/login 当回跳目标", async () => {
  window.history.replaceState({}, "", "/admin/login")
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true, next: "/admin/overview" }))
  const onSuccess = vi.fn()

  render(<Login onSuccess={onSuccess} />)
  fireEvent.change(screen.getByLabelText("访问密钥"), { target: { value: "secret" } })
  fireEvent.click(screen.getByRole("button", { name: "进入后台" }))

  await waitFor(() => assert.equal(onSuccess.mock.calls.length, 1))
  const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
  assert.equal(body.next, "/admin/overview")
})

test("登录失败显示后端错误信息", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(jsonResponse({ error: "访问密钥不正确，请重试。" }, 401))
  render(<Login onSuccess={() => {}} />)
  fireEvent.change(screen.getByLabelText("访问密钥"), { target: { value: "wrong" } })
  fireEvent.click(screen.getByRole("button", { name: "进入后台" }))

  await waitFor(() => assert.ok(screen.getByText("访问密钥不正确，请重试。")))
  assert.equal(fetchMock.mock.calls.length, 1)
})

test("AuthGate：未登录显示 Login，已登录渲染后台", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
    .mockResolvedValueOnce(jsonResponse({ authenticated: true }))

  const { unmount } = render(
    <AuthGate>
      <div>后台内容</div>
    </AuthGate>,
  )
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "进入后台" })))
  assert.equal(screen.queryByText("后台内容"), null)
  unmount()

  render(
    <AuthGate>
      <div>后台内容</div>
    </AuthGate>,
  )
  await waitFor(() => assert.ok(screen.getByText("后台内容")))
})
