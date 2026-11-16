/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"

import { DaysDropdown } from "../web/pages/callers/DaysDropdown.tsx"

afterEach(cleanup)

function setup(overrides: Partial<Parameters<typeof DaysDropdown>[0]> = {}) {
  const props = {
    days: [],
    daysOpen: true,
    setOpen: vi.fn(),
    availableDays: ["2026-11-16"],
    toggleDay: vi.fn(),
    applyPreset: vi.fn(),
    ...overrides,
  }
  render(<DaysDropdown {...props} />)
  return props
}

test("点击面板外部（document mousedown）→ 收起", () => {
  const props = setup()
  fireEvent.mouseDown(document.body)
  assert.equal(props.setOpen.mock.calls.length, 1)
  assert.equal(props.setOpen.mock.calls[0][0], false)
})

test("点击面板内部 → 不收起", () => {
  const props = setup()
  fireEvent.mouseDown(screen.getByText("最近一天"))
  assert.equal(props.setOpen.mock.calls.length, 0)
})

test("点切换按钮 → 切换 open", () => {
  const props = setup()
  fireEvent.click(screen.getByRole("button", { name: /未选择|默认今天|点击/ }))
  assert.equal(props.setOpen.mock.calls.length >= 1, true)
})
