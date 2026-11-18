/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"

import { ModelsPanelHost } from "../web/pages/channels/ModelsPanelHost"

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function setup(provider: string, sectionClass: string) {
  document.body.innerHTML = `
    <div class="dim-jh-providerRow" data-provider="${provider}">
      <button class="dim-jh-provider" aria-selected="true">
        <span class="dim-jh-providerLabel"><strong>${provider}</strong></span>
      </button>
    </div>
    <main class="dim-jh-panel"><section class="${sectionClass}">渠道设置</section></main>
  `
  const models = ["kimi", "other"].map((id) => ({ id, name: id, state: "ok", enabledAccounts: 1, usableAccounts: 1 }))
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ models, counts: { total: 2, usable: 2, partial: 0, limited: 0, off: 0, dead: 0 } }),
    })),
  )
  render(<ModelsPanelHost />)
  return document.querySelector<HTMLElement>("main > section")!
}

for (const [provider, sectionClass] of [
  ["codearts", "dim-jh-accountSection"],
  ["aggregate", "dim-jh-aggPanel"],
]) {
  test(`${provider}：模型搜索期间隐藏渠道设置，返回时恢复`, async () => {
    const section = setup(provider, sectionClass)
    fireEvent.click(await screen.findByRole("tab", { name: "可用模型" }))
    await waitFor(() => assert.equal(section.style.display, "none"))
    await screen.findByRole("switch", { name: "kimi 是否启用" })

    const input = screen.getByPlaceholderText("筛选模型…")
    fireEvent.change(input, { target: { value: "kimi" } })
    await waitFor(() => assert.equal(screen.queryByRole("switch", { name: "other 是否启用" }), null))
    assert.equal(section.style.display, "none")
    fireEvent.change(input, { target: { value: "no-match" } })
    await screen.findByText("没有匹配的模型")
    assert.equal(section.style.display, "none")

    fireEvent.click(screen.getByRole("tab", { name: "账号管理" }))
    await waitFor(() => assert.equal(section.style.display, ""))
    assert.equal(document.querySelector<HTMLElement>("[data-c2a-models]")!.style.display, "none")
  })
}

test("没有支持的渠道内容时隐藏 Tab 和模型面板", async () => {
  setup("unknown", "unknown-panel")
  await waitFor(() => assert.equal(document.querySelector<HTMLElement>("[data-c2a-tabs]")!.style.display, "none"))
  assert.equal(document.querySelector<HTMLElement>("[data-c2a-models]")!.style.display, "none")
})
