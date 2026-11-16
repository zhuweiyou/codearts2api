/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"

import { FormModal } from "../web/pages/callers/FormModal.tsx"

afterEach(() => {
  cleanup()
  delete (window as any).__c2aFormBackdropClose
})

const fields = [{ key: "name", label: "名称" }]

function renderModal() {
  const onClose = vi.fn()
  const { container } = render(<FormModal title="新建分组" fields={fields} onOk={async () => {}} onClose={onClose} />)
  const overlay = container.firstChild as HTMLElement
  return { onClose, overlay }
}

test("Esc 关闭", () => {
  const { onClose } = renderModal()
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
  assert.equal(onClose.mock.calls.length, 1)
})

test("默认点遮罩不关", () => {
  const { onClose, overlay } = renderModal()
  fireEvent.mouseDown(overlay)
  fireEvent.click(overlay)
  assert.equal(onClose.mock.calls.length, 0)
})

test("__c2aFormBackdropClose=true 时点遮罩关闭", () => {
  ;(window as any).__c2aFormBackdropClose = true
  const { onClose, overlay } = renderModal()
  fireEvent.mouseDown(overlay)
  fireEvent.click(overlay)
  assert.equal(onClose.mock.calls.length, 1)
})

test("首字段自动聚焦", () => {
  renderModal()
  const input = screen.getByRole("textbox")
  assert.equal(document.activeElement, input)
})
