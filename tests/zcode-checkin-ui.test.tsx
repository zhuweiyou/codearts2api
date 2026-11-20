/** @vitest-environment jsdom */
/**
 * 总览「自动签到」里 ZCode 块的组件契约：
 * - 有 zcodeCheckin 数据时渲染开关与状态；没有时不渲染（旧快照兼容）；
 * - env 锁定时开关置灰并展示原因；
 * - 拨动开关 POST /enabled 并触发总览刷新；失败把错误显示出来；
 * - 逐账号明细按 kind 着色文案。
 */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"

import { CheckinSection } from "../web/pages/overview/sections.tsx"

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const Z_BASE = {
  enabled: true,
  envLocked: false,
  slots: ["19:05", "20:05", "21:05", "22:05"],
  today: "2026-11-20",
  ranSlots: [],
  ranToday: false,
  nextSlot: "19:05",
  lastAt: 0,
  lastSlot: "",
  lastResult: null,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("无 zcodeCheckin 数据：不渲染 ZCode 块（旧快照兼容）", () => {
  render(<CheckinSection data={{ checkin: null, accounts: [] }} />)
  assert.ok(screen.getByText("没有签到状态文件"))
  assert.equal(screen.queryByText("ZCode 自动领取"), null)
})

test("有数据无账号：渲染开关与「没有 ZCode 账号」提示", () => {
  render(<CheckinSection data={{ checkin: null, zcodeCheckin: Z_BASE, accounts: [] }} />)
  assert.ok(screen.getByText("ZCode 自动领取"))
  assert.ok(screen.getByText(/当前没有 ZCode 账号/))
  const toggle = screen.getByLabelText("ZCode 自动领取开关") as HTMLInputElement
  assert.equal(toggle.checked, true)
  assert.equal(toggle.disabled, false)
})

test("env 锁定：开关置灰并展示环境变量原因", () => {
  render(
    <CheckinSection
      data={{ checkin: null, zcodeCheckin: { ...Z_BASE, enabled: false, envLocked: true }, accounts: [] }}
    />,
  )
  const toggle = screen.getByLabelText("ZCode 自动领取开关") as HTMLInputElement
  assert.equal(toggle.disabled, true)
  assert.ok(screen.getByText(/已被环境变量 CODEARTS2API_ZCODE_AUTO_CHECKIN=0 停用/))
})

test("拨动开关：POST /enabled 取反当前值，成功后触发刷新", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ...Z_BASE, enabled: false }))
  const onRefresh = vi.fn().mockResolvedValue(undefined)
  render(
    <CheckinSection
      data={{ checkin: null, zcodeCheckin: Z_BASE, accounts: [{ provider: "zcode" }] }}
      onRefresh={onRefresh}
    />,
  )
  fireEvent.click(screen.getByLabelText("ZCode 自动领取开关"))
  await waitFor(() => assert.equal(fetchMock.mock.calls.length, 1))
  const [url, init] = fetchMock.mock.calls[0] as any[]
  assert.equal(url, "/admin/zcode-checkin/api/enabled")
  assert.equal(init.method, "POST")
  assert.deepEqual(JSON.parse(init.body), { enabled: false })
  await waitFor(() => assert.equal(onRefresh.mock.calls.length, 1))
})

test("开关失败：错误文案显示给用户", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "已被环境变量停用" }, 409))
  render(<CheckinSection data={{ checkin: null, zcodeCheckin: Z_BASE, accounts: [] }} />)
  fireEvent.click(screen.getByLabelText("ZCode 自动领取开关"))
  await waitFor(() => assert.ok(screen.getByText("已被环境变量停用")))
})

test("逐账号明细：领取成功 / 已领 / 失败三种文案", () => {
  const z = {
    ...Z_BASE,
    ranToday: true,
    ranSlots: ["19:05"],
    lastAt: Date.parse("2026-11-20T11:05:30Z"),
    lastSlot: "19:05",
    lastResult: {
      ok: true,
      text: "3 个账号，领取 1，已领/暂无 1，失败 1",
      accounts: [
        { id: "a", nickname: "号A", kind: "claimed", message: "" },
        { id: "b", nickname: "号B", kind: "already-claimed", message: "今日暂无可领额度" },
        { id: "c", nickname: "号C", kind: "failed", message: "找不到浏览器" },
      ],
    },
  }
  render(<CheckinSection data={{ checkin: null, zcodeCheckin: z, accounts: [{ provider: "zcode" }] }} />)
  assert.ok(screen.getByText("号A"))
  assert.ok(screen.getByText("领取成功"))
  assert.ok(screen.getByText(/已领\/暂无 · 今日暂无可领额度/))
  assert.ok(screen.getByText(/失败 · 找不到浏览器/))
  assert.ok(screen.getByText(/已跑 1 轮/))
})
